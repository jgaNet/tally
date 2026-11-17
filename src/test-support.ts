import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication, Application } from './app';

/** A directory of its own, for one test's database file, removed by `remove`. */
export function temporaryDatabase(): { path: string; remove(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'tally-test-'));
  return { path: join(directory, 'tally.db'), remove: () => rmSync(directory, { recursive: true, force: true }) };
}

/**
 * Starts an application on a random port, on the database file at `databasePath`. Without a payment provider
 * configured, as a server without `PROVIDER_URL` is; a test that needs one gives its URL and secret.
 */
export async function startApplication(
  databasePath: string,
  provider: { providerUrl?: string; providerWebhookSecret?: string; providerTimeoutMs?: number } = {},
): Promise<Application> {
  const app = await createApplication({
    databasePath,
    providerUrl: '',
    providerWebhookSecret: '',
    ...provider,
  });
  await app.start(0);
  return app;
}

/** Where an application answers: what `call` needs of it. */
export type Reachable = Pick<Application, 'address' | 'apiPrefix'>;

export interface Answer {
  status: number;
  // Response bodies are JSON read by the tests, whose assertions say what each one holds.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/**
 * One request to the application; a JSON `body` is sent as JSON, a `token` as the bearer token, and `headers`
 * are sent as they are.
 */
export async function call(
  app: Reachable,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  {
    body,
    token,
    raw,
    headers: extra = {},
  }: { body?: unknown; token?: string; raw?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...extra };
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${app.address}/${app.apiPrefix}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

export const ada = { email: 'ada@example.com', password: 'analytical-engine', name: 'Ada Lovelace' };

/**
 * One request asked of the fake provider: the path it was asked on, and the body Tally sent: a payment's amount,
 * currency and payee, or, for a refund, only its reference. A request with no body (a `GET`, which asks whether the
 * provider knows an account) has no `body`.
 */
export interface ProviderRequest {
  path: string;
  body?: { reference: string; amount?: number; currency?: string; payee?: string };
}

/** How the fake provider answers: its status, and the body it sends, as JSON, or as the `raw` text when given. */
export interface ProviderAnswer {
  status: number;
  body?: unknown;
  raw?: string;
  delayMs?: number;
}

export interface FakeProvider {
  /** The base of its API, as `PROVIDER_URL` gives it: no trailing slash. */
  readonly url: string;
  /** Every request it has received, the earliest first. */
  readonly requests: ProviderRequest[];
  /**
   * How it answers the next request. By default: for a `GET` of an account (no body), `200` with the account's id,
   * so every account is known; for a payment, `201` with a new payment id and a link; for a refund, `201` with a new
   * refund id. Set by the test.
   */
  answer: (request: ProviderRequest, number: number) => ProviderAnswer;
  stop(): Promise<void>;
}

/** A payment provider on a port of its own, which a test may make answer as it likes. */
export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: ProviderRequest[] = [];
  const provider: FakeProvider = {
    url: '',
    requests,
    answer: (request, number) => {
      if (request.body === undefined) {
        const accountId = decodeURIComponent(request.path.slice(request.path.lastIndexOf('/') + 1));
        return { status: 200, body: { id: accountId } };
      }
      return request.path.endsWith('/refunds')
        ? { status: 201, body: { id: `ref_${number}` } }
        : { status: 201, body: { id: `pay_${number}`, payUrl: `https://pay.example/pay_${number}` } };
    },
    stop: async () => undefined,
  };
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const request: ProviderRequest = {
        path: incoming.url ?? '',
        body: text === '' ? undefined : JSON.parse(text),
      };
      requests.push(request);
      const answer = provider.answer(request, requests.length);
      setTimeout(() => {
        outgoing.writeHead(answer.status, { 'content-type': 'application/json' });
        outgoing.end(answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  Object.assign(provider, {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return provider;
}
