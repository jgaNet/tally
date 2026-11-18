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
  /** The provider's id of the payee's payout account. */
  payee: string;
}

/** How the fake provider answers `GET /accounts/{id}` for a known account: `200 { id }`, or as `mode` says. */
export type ProviderAccountMode = 'accept' | 'refuse' | 'malformed' | 'hang' | 'other';

export interface FakeProvider {
  /** The base URL, as `PROVIDER_URL` gives it: no trailing slash. */
  url: string;
  /** Every request for a payment, in the order received. */
  requests: ProviderPaymentRequest[];
  /** The payments made so far, `id` being what the provider's webhooks name. */
  payments: { id: string; payUrl: string; reference: string }[];
  /** How it answers the next requests for a payment: `accept`, `refuse` (a `500`), `malformed` or `hang`. */
  mode: 'accept' | 'refuse' | 'malformed' | 'hang';
  /** Every request for a refund, in the order received: the provider's payment id and the reference. */
  refunds: { paymentId: string; reference: string }[];
  /** How it answers the next requests for a refund, as `mode` does for a payment. */
  refundMode: 'accept' | 'refuse' | 'malformed' | 'hang';
  /** Every account asked about by `GET /accounts/{id}`, in the order asked. */
  accountRequests: string[];
  /** The accounts it does not know: a `404` for each. Every other account is known. */
  unknownAccounts: string[];
  /** How it answers the next requests about a known account: `accept` (`200 { id }`), `refuse` (a `500`), `malformed`, `hang` or `other` (another id). */
  accountMode: ProviderAccountMode;
  close(): Promise<void>;
}

const REFUND_PATH = /^\/payments\/([^/]+)\/refunds$/;
const ACCOUNT_PATH = /^\/accounts\/([^/]+)$/;

/**
 * A provider on the loopback interface, answering `POST /payments` as `mode` says, and
 * `POST /payments/{id}/refunds` as `refundMode` says.
 */
export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: ProviderPaymentRequest[] = [];
  const payments: { id: string; payUrl: string; reference: string }[] = [];
  const refunds: { paymentId: string; reference: string }[] = [];
  const accountRequests: string[] = [];
  const provider = {
    requests,
    payments,
    refunds,
    accountRequests,
    unknownAccounts: [] as string[],
    mode: 'accept',
    refundMode: 'accept',
    accountMode: 'accept',
  } as FakeProvider;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => (raw += chunk));
    request.on('end', () => {
      const account = ACCOUNT_PATH.exec(request.url ?? '');
      if (request.method === 'GET' && account) {
        const id = decodeURIComponent(account[1]);
        accountRequests.push(id);
        if (provider.unknownAccounts.includes(id)) {
          response.writeHead(404).end('{}');
          return;
        }
        if (provider.accountMode === 'hang') {
          return;
        }
        if (provider.accountMode === 'refuse') {
          response.writeHead(500).end('{}');
          return;
        }
        if (provider.accountMode === 'malformed') {
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ known: true }));
          return;
        }
        const answered = provider.accountMode === 'other' ? 'someone-else' : id;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: answered }));
        return;
      }
      const refund = REFUND_PATH.exec(request.url ?? '');
      if (request.method === 'POST' && refund) {
        const body = JSON.parse(raw) as { reference: string };
        refunds.push({ paymentId: decodeURIComponent(refund[1]), reference: body.reference });
        if (provider.refundMode === 'hang') {
          return;
        }
        if (provider.refundMode === 'refuse') {
          response.writeHead(500).end('{}');
          return;
        }
        if (provider.refundMode === 'malformed') {
          response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ refunded: true }));
          return;
        }
        response
          .writeHead(201, { 'content-type': 'application/json' })
          .end(JSON.stringify({ id: `ref-${refunds.length}` }));
        return;
      }
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

/** Sets the payout account of the signed-in `token` to `accountId` at the provider, which knows it. */
export async function setPayoutAccount(app: Application, token: string, accountId: string): Promise<void> {
  const response = await send(app, 'PUT', '/accounts/me/payout-account', { token, payload: { accountId } });
  if (response.statusCode !== 204) {
    throw new Error(`setting the payout account failed: ${response.statusCode} ${response.body}`);
  }
}

/** How the fake rates service answers a request for a rate: `answer` (what it knows, else a `404`), or as its mode says. */
export type RatesMode = 'answer' | 'refuse' | 'malformed' | 'hang';

export interface FakeRatesService {
  /** The base URL, as `RATES_URL` gives it: no trailing slash. */
  url: string;
  /** Every request for a rate, in the order received: the currency asked from, to, and the day. */
  requests: { from: string; to: string; date: string }[];
  /** The rates it knows, by `ratesKey`: a rate that is not there is answered with a `404`. */
  rates: Map<string, string>;
  /** How it answers: `answer` (`200 { rate }` for a rate it knows), `refuse` (a `500`), `malformed` (`200` with a rate that is not text) or `hang`. */
  mode: RatesMode;
  /** Makes it know `rate` for `from` in `to` on `date`. */
  offer(from: string, to: string, date: string, rate: string): void;
  close(): Promise<void>;
}

/** The key of a rate in `FakeRatesService.rates`. */
export const ratesKey = (from: string, to: string, date: string): string => `${from}/${to}/${date}`;

const RATE_PATH = /^\/rates\/([A-Z]{3})\/([A-Z]{3})$/;

/** A rates service on the loopback interface, answering `GET /rates/{from}/{to}?date=` as `mode` says. */
export async function startFakeRatesService(): Promise<FakeRatesService> {
  const requests: { from: string; to: string; date: string }[] = [];
  const rates = new Map<string, string>();
  const service = {
    requests,
    rates,
    mode: 'answer',
    offer(from: string, to: string, date: string, rate: string) {
      rates.set(ratesKey(from, to, date), rate);
    },
  } as FakeRatesService;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = RATE_PATH.exec(url.pathname);
    if (request.method !== 'GET' || path === null) {
      response.writeHead(404).end();
      return;
    }
    const [from, to] = [path[1], path[2]];
    const date = url.searchParams.get('date') ?? '';
    requests.push({ from, to, date });
    if (service.mode === 'hang') {
      return;
    }
    if (service.mode === 'refuse') {
      response.writeHead(500).end('{}');
      return;
    }
    if (service.mode === 'malformed') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rate: 1.0625 }));
      return;
    }
    const rate = rates.get(ratesKey(from, to, date));
    if (rate === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rate }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  service.url = `http://127.0.0.1:${port}`;
  service.close = () =>
    new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return service;
}
