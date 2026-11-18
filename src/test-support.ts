import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createApplication, Application } from './app';
import { openDatabase } from './database';

/** The PostgreSQL server the tests use: the one `DATABASE_URL` names. Each test's database is made on it. */
function serverUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the PostgreSQL server the tests use.');
  return url;
}

/** Runs `work` on a connection to the server, which is closed after it. */
async function onServer<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: serverUrl() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * A database of its own on the server the tests use, for one test: its `url` is what `startApplication` takes, which makes
 * the database; `remove` drops it, once the application has stopped.
 */
export function temporaryDatabase(): { url: string; remove(): Promise<void> } {
  const location = new URL(serverUrl());
  const name = `tally_test_${randomUUID().replaceAll('-', '')}`;
  location.pathname = `/${name}`;
  return {
    url: location.toString(),
    remove: async () => {
      await onServer(client => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** Makes the database at `url` if it does not exist yet: the tests' own databases are made here, when they are first used. */
export async function makeDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  await onServer(async client => {
    try {
      await client.query(`CREATE DATABASE ${name}`);
    } catch (error) {
      // 42P04: the database exists already, as another server of the test made it.
      if ((error as { code?: string }).code !== '42P04') throw error;
    }
  });
}

/**
 * Starts an application on a random port, on the database at `databaseUrl`. Without a payment provider, a
 * rates service or a receipts store configured, as a server without `PROVIDER_URL`, `RATES_URL` or `RECEIPTS_URL` is; a
 * test that needs one gives its URL.
 */
export async function startApplication(
  databaseUrl: string,
  services: {
    databasePath?: string;
    providerUrl?: string;
    providerWebhookSecret?: string;
    providerTimeoutMs?: number;
    ratesUrl?: string;
    ratesTimeoutMs?: number;
    receiptsUrl?: string;
    receiptsTimeoutMs?: number;
    adminEmails?: string[];
  } = {},
): Promise<Application> {
  await makeDatabase(databaseUrl);
  const app = await createApplication({
    databaseUrl,
    providerUrl: '',
    providerWebhookSecret: '',
    ratesUrl: '',
    receiptsUrl: '',
    ...services,
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
   * so every account is known; for a payment, `201` with a new payment id, a link and a fee of 0; for a refund, `201` with a new
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
        : { status: 201, body: { id: `pay_${number}`, payUrl: `https://pay.example/pay_${number}`, fee: 0 } };
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

/** The rows a query gives on the database at `url`, read apart from the application on a connection of its own. */
export async function readRows(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const db = await openDatabase(url);
  try {
    return await db.all<Record<string, unknown>>(sql, params);
  } finally {
    await db.close();
  }
}

/** How many rows a table of the database at `url` holds, counted apart from the application. */
export async function countRows(url: string, table: string): Promise<number> {
  const [row] = await readRows(url, `SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row.n);
}

/** One request asked of the fake rates service: the currencies of the rate, and the day asked for, if one was. */
export interface RatesRequest {
  from: string;
  to: string;
  date: string | null;
}

/** How the fake rates service answers: its status, and the body it sends, as JSON, or as the `raw` text when given. */
export interface RatesAnswer {
  status: number;
  body?: unknown;
  raw?: string;
  delayMs?: number;
}

export interface FakeRates {
  /** The base of its API, as `RATES_URL` gives it: no trailing slash. */
  readonly url: string;
  /** Every request it has received, the earliest first. */
  readonly requests: RatesRequest[];
  /** How it answers the next request. By default, `404`: it has no rate. */
  answer: (request: RatesRequest) => RatesAnswer;
  stop(): Promise<void>;
}

/** A rates service on a port of its own, which a test may make answer as it likes. */
export async function startFakeRates(): Promise<FakeRates> {
  const requests: RatesRequest[] = [];
  const rates: FakeRates = {
    url: '',
    requests,
    answer: () => ({ status: 404 }),
    stop: async () => undefined,
  };
  const server = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '', 'http://rates.invalid');
    const [, , from = '', to = ''] = url.pathname.split('/');
    const request: RatesRequest = {
      from: decodeURIComponent(from),
      to: decodeURIComponent(to),
      date: url.searchParams.get('date'),
    };
    requests.push(request);
    const answer = rates.answer(request);
    setTimeout(() => {
      outgoing.writeHead(answer.status, { 'content-type': 'application/json' });
      outgoing.end(answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
    }, answer.delayMs ?? 0);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  Object.assign(rates, {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return rates;
}
