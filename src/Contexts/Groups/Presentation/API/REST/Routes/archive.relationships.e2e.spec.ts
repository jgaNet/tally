import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * The relationships request 27 crosses, each proved through the API: a thing is made in one context and its id is kept, then the other
 * context is read through the API and finds the thing by that id (Groups → Ledger, Groups → Settlements, Ledger → Groups, Settlements → Groups).
 */

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
let previousEnv: { url?: string; secret?: string };
const PROVIDER_SECRET = 'archive-relationships-secret';

beforeAll(async () => {
  // A stand-in for the provider: every payout account is known, and every payment link is given.
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
        return;
      }
      const paymentId = `pay_${Math.random().toString(36).slice(2, 10)}`;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: paymentId, fee: 0, payUrl: `https://pay.example/${paymentId}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  previousEnv = { url: process.env.PROVIDER_URL, secret: process.env.PROVIDER_WEBHOOK_SECRET };
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = PROVIDER_SECRET;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise(resolve => provider.close(resolve));
  restoreEnv('PROVIDER_URL', previousEnv.url);
  restoreEnv('PROVIDER_WEBHOOK_SECRET', previousEnv.secret);
});

const restoreEnv = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

type Operation = { status: string; result?: string; error?: { type: string; message: string } };

/** Follows an operation to its end, as a client answered 202 does. */
async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Answers a command: a 202 is followed to its end, anything else is its status. */
async function answered(request: Promise<{ status: number; body: unknown }>, token: string): Promise<Operation> {
  const answer = await request;
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` };
  return outcome((answer.body as { operationId: string }).operationId, token);
}

async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email, password: 'correct horse', name },
  });
  const operation = await outcome((signUp.body as { operationId: string }).operationId);
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email, password: 'correct horse' },
  });
  return { id: operation.result as string, token: (login.body as { token: string }).token };
}

async function createGroup(token: string, name: string): Promise<string> {
  const answer = await http.request('POST', `${api}/groups`, { token, body: { name, currency: 'EUR' } });
  return (await outcome((answer.body as { operationId: string }).operationId, token)).result as string;
}

/** Bob joins Alice's group by an invitation made in the group, and the group's id is what was kept. */
async function join(ownerToken: string, groupId: string, joiner: string): Promise<void> {
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ownerToken });
  const link = (await outcome((invite.body as { operationId: string }).operationId, ownerToken)).result as string;
  const accepted = await answered(http.request('POST', `${api}/invitations/${link}/accept`, { token: joiner }), joiner);
  expect(accepted.status).toBe('SUCCESS');
}

/** An expense of `amount`, paid by the caller and split equally between the two members given. */
const recordBetween = (token: string, groupId: string, amount: number, members: string[]) =>
  answered(
    http.request('POST', `${api}/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Dinner', amount, date: '2026-11-01', splitBetween: members },
    }),
    token,
  );

const archive = (token: string, groupId: string) =>
  answered(http.request('POST', `${api}/groups/${groupId}/archive`, { token }), token);

describe('the relationships request 27 crosses', () => {
  it('Groups → Ledger: a group made in Groups is the group an expense is recorded in, and the expense is found under its id', async () => {
    const alice = await signedIn('alice.rel@example.test', 'Alice');
    const bob = await signedIn('bob.rel@example.test', 'Bob');
    const group = await createGroup(alice.token, 'Flat');
    await join(alice.token, group, bob.token);

    const recorded = await recordBetween(alice.token, group, 1000, [alice.id, bob.id]);
    expect(recorded.status).toBe('SUCCESS');

    const expense = await http.get(`${api}/expenses/${recorded.result}`, { token: bob.token });
    expect(expense.body).toMatchObject({ id: recorded.result, groupId: group, paidBy: alice.id });
  });

  it('Groups → Settlements: a member of a group made in Groups settles with another in it, and the settlement is found under its id', async () => {
    const alice = await signedIn('alice.set@example.test', 'Alice');
    const bob = await signedIn('bob.set@example.test', 'Bob');
    const group = await createGroup(alice.token, 'Flat');
    await join(alice.token, group, bob.token);
    expect((await recordBetween(alice.token, group, 1000, [alice.id, bob.id])).status).toBe('SUCCESS');

    // Alice records the cash Bob paid her: she is the payee, and Bob owes her 500.
    const settled = await answered(
      http.request('POST', `${api}/groups/${group}/settlements/cash`, {
        token: alice.token,
        body: { from: bob.id, amount: 500 },
      }),
      alice.token,
    );
    expect(settled.status).toBe('SUCCESS');

    const settlement = await http.get(`${api}/settlements/${settled.result}`, { token: alice.token });
    expect(settlement.body).toMatchObject({
      id: settled.result,
      groupId: group,
      from: bob.id,
      to: alice.id,
      status: 'paid',
    });
  });

  it('Ledger → Groups: an expense recorded in Ledger is a balance Groups reads, and the group it is in stays open until it is settled', async () => {
    const alice = await signedIn('alice.led@example.test', 'Alice');
    const bob = await signedIn('bob.led@example.test', 'Bob');
    const group = await createGroup(alice.token, 'Flat');
    await join(alice.token, group, bob.token);
    const expense = await recordBetween(alice.token, group, 1000, [alice.id, bob.id]);
    expect(expense.status).toBe('SUCCESS');

    // Groups reads the balances Ledger keeps for the group, and refuses to archive it while one is not 0.
    expect((await archive(alice.token, group)).error?.type).toBe('BalancesNotSettled');
    const read = await http.get(`${api}/groups/${group}`, { token: alice.token });
    expect(read.body).toMatchObject({ id: group, ownerId: alice.id });
    expect(read.body).not.toHaveProperty('archivedAt');
  });

  it('Settlements → Groups: a payment waiting at the provider in a group made in Groups keeps the group from being archived', async () => {
    const alice = await signedIn('alice.pay@example.test', 'Alice');
    const bob = await signedIn('bob.pay@example.test', 'Bob');
    const group = await createGroup(alice.token, 'Flat');
    await join(alice.token, group, bob.token);
    const expense = await recordBetween(alice.token, group, 1000, [alice.id, bob.id]);
    expect(expense.status).toBe('SUCCESS');

    // Alice is paid through the provider, so she has a payout account; Bob pays her 500 through the provider and it waits there.
    const payout = await http.request('PUT', `${api}/accounts/me/payout-account`, {
      token: alice.token,
      body: { accountId: `payout_${alice.id}` },
    });
    expect(payout.status).toBe(202);
    const paid = await answered(
      http.request('POST', `${api}/groups/${group}/settlements/provider`, {
        token: bob.token,
        body: { to: alice.id, amount: 500 },
      }),
      bob.token,
    );
    expect(paid.status).toBe('SUCCESS');

    // Alice deletes the expense: every balance is 0 again, but the payment still waits at the provider.
    expect(
      (await answered(http.request('DELETE', `${api}/expenses/${expense.result}`, { token: alice.token }), alice.token))
        .status,
    ).toBe('SUCCESS');
    expect((await archive(alice.token, group)).error?.type).toBe('ArchiveWaitsForPayment');
    const settlement = await http.get(`${api}/settlements/${paid.result}`, { token: alice.token });
    expect(settlement.body).toMatchObject({ id: paid.result, groupId: group, status: 'pending' });
  });
});
