import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from './app';

/** A database file no other test shares. */
export function temporaryDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tally-test-')), 'tally.db');
}

/** Sends a request to the application without a socket: `/v1` plus `path`. */
export function send(
  app: Application,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: { token?: string; payload?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  return app.server.inject({
    method,
    url: `/${app.apiPrefix}${path}`,
    headers,
    payload: options.payload as object | undefined,
  });
}

export const validSignup = {
  email: 'ada@example.com',
  password: 'correct horse',
  name: 'Ada',
};

/**
 * Makes the account of `joinerToken` a member of `groupId`, through an invitation that the member
 * `inviterToken` creates and the joiner accepts.
 */
export async function joinThroughInvitation(
  app: Application,
  inviterToken: string,
  joinerToken: string,
  groupId: string,
): Promise<void> {
  const created = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: inviterToken });
  if (created.statusCode !== 201) {
    throw new Error(`invitation failed: ${created.statusCode} ${created.body}`);
  }
  const accepted = await send(app, 'POST', `/invitations/${created.json<{ id: string }>().id}/accept`, {
    token: joinerToken,
  });
  if (accepted.statusCode !== 201) {
    throw new Error(`joining failed: ${accepted.statusCode} ${accepted.body}`);
  }
}

/** Signs an account up and in; returns its id and token. */
export async function signedUpAccount(app: Application, overrides: Partial<typeof validSignup> = {}) {
  const body = { ...validSignup, ...overrides };
  const created = await send(app, 'POST', '/accounts', { payload: body });
  if (created.statusCode !== 201) {
    throw new Error(`sign-up failed: ${created.statusCode} ${created.body}`);
  }
  const login = await send(app, 'POST', '/accounts/login', {
    payload: { email: body.email, password: body.password },
  });
  return { id: created.json<{ id: string }>().id, token: login.json<{ token: string }>().token };
}

/** What the fake provider was asked for: `POST /payments`, and the payment it made. */
export interface ProviderPaymentRequest {
  reference: string;
  amount: number;
  currency: string;
}

export interface FakeProvider {
  /** The base URL, as `PROVIDER_URL` gives it: no trailing slash. */
  url: string;
  /** Every request for a payment, in the order received. */
  requests: ProviderPaymentRequest[];
  /** The payments made so far, `id` being what the provider's webhooks name. */
  payments: { id: string; payUrl: string; reference: string }[];
  /** How it answers the next requests: `accept`, `refuse` (a `500`), `malformed` or `hang`. */
  mode: 'accept' | 'refuse' | 'malformed' | 'hang';
  close(): Promise<void>;
}

/** A provider on the loopback interface, answering `POST /payments` as `mode` says. */
export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: ProviderPaymentRequest[] = [];
  const payments: { id: string; payUrl: string; reference: string }[] = [];
  const provider = { requests, payments, mode: 'accept' } as FakeProvider;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => (raw += chunk));
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/payments') {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as ProviderPaymentRequest;
      requests.push(body);
      if (provider.mode === 'hang') {
        return;
      }
      if (provider.mode === 'refuse') {
        response.writeHead(500).end('{}');
        return;
      }
      if (provider.mode === 'malformed') {
        response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'x' }));
        return;
      }
      const id = `pay-${payments.length + 1}`;
      const payUrl = `https://pay.example.test/${id}`;
      payments.push({ id, payUrl, reference: body.reference });
      response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id, payUrl }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  provider.url = `http://127.0.0.1:${port}`;
  provider.close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return provider;
}
