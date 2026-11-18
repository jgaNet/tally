import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * The relationships request 31 crosses, each proved through the API: a thing is made in one context and its id is kept, then the other
 * context is read through the API and finds the thing by that id, once the merge has moved it (Groups → Ledger, Groups → Settlements,
 * Ledger → Groups, Settlements → Groups).
 */

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
let previousEnv: { url?: string; secret?: string };
const PROVIDER_SECRET = 'merge-relationships-secret';
type Balance = { memberId: string; balance: number };

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

/** Merges the group `from` into the group `into`, as its owner: the answer, followed to its end. */
const merge = (token: string, into: string, from: string) =>
  answered(http.request('POST', `${api}/groups/${into}/merge`, { token, body: { from } }), token);

/** Reads until the read is what the test waits for: the move is made within seconds, after the command answered. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 200 && !done(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}

describe('the relationships request 31 crosses', () => {
  it('Groups → Ledger (GroupsMerged): an expense recorded in a group merged into another is found in Ledger under its id, in the group kept', async () => {
    const alice = await signedIn('alice.merge.rel@example.test', 'Alice');
    const bob = await signedIn('bob.merge.rel@example.test', 'Bob');
    const flat = await createGroup(alice.token, 'Flat');
    const trip = await createGroup(alice.token, 'Trip');
    await join(alice.token, trip, bob.token);
    const expense = await recordBetween(alice.token, trip, 1000, [alice.id, bob.id]);
    expect(expense.status).toBe('SUCCESS');

    expect((await merge(alice.token, flat, trip)).status).toBe('SUCCESS');

    const found = await eventually(
      async () => http.get(`${api}/expenses/${expense.result}`, { token: alice.token }),
      answer => answer.status === 200 && (answer.body as { groupId: string }).groupId === flat,
    );
    expect(found.status).toBe(200);
    expect((found.body as { groupId: string }).groupId).toBe(flat);
  });

  it('Groups → Ledger (GroupCurrency, GroupMembers, PassedBalances): a member who came with the merge is in a split recorded in the group kept', async () => {
    const alice = await signedIn('alice.merge.split@example.test', 'Alice');
    const bob = await signedIn('bob.merge.split@example.test', 'Bob');
    const flat = await createGroup(alice.token, 'Flat');
    const trip = await createGroup(alice.token, 'Trip');
    await join(alice.token, trip, bob.token);
    expect((await merge(alice.token, flat, trip)).status).toBe('SUCCESS');

    // Bob is a member of the group kept now, so Ledger splits an expense recorded there with him, in the group's currency.
    const expense = await recordBetween(alice.token, flat, 1000, [alice.id, bob.id]);
    expect(expense.status).toBe('SUCCESS');
    const found = await http.get(`${api}/expenses/${expense.result}`, { token: alice.token });
    expect(found.status).toBe(200);
    expect((found.body as { shares: { memberId: string }[] }).shares.map(share => share.memberId).sort()).toEqual(
      [alice.id, bob.id].sort(),
    );
  });

  it('Groups → Settlements (GroupsMerged): a settlement recorded in a group merged into another is found in the group kept under its id', async () => {
    const alice = await signedIn('alice.merge.settle@example.test', 'Alice');
    const bob = await signedIn('bob.merge.settle@example.test', 'Bob');
    const flat = await createGroup(alice.token, 'Flat');
    const trip = await createGroup(alice.token, 'Trip');
    await join(alice.token, trip, bob.token);
    expect((await recordBetween(alice.token, trip, 1000, [alice.id, bob.id])).status).toBe('SUCCESS');
    const paid = await answered(
      http.request('POST', `${api}/groups/${trip}/settlements/cash`, {
        token: alice.token,
        body: { from: bob.id, amount: 500 },
      }),
      alice.token,
    );
    expect(paid.status).toBe('SUCCESS');

    expect((await merge(alice.token, flat, trip)).status).toBe('SUCCESS');

    const found = await eventually(
      async () => http.get(`${api}/settlements/${paid.result}`, { token: alice.token }),
      answer => answer.status === 200 && (answer.body as { groupId: string }).groupId === flat,
    );
    expect((found.body as { groupId: string }).groupId).toBe(flat);
  });

  it('Ledger → Groups (MemberBalances): a member who leaves the group kept passes on the balance the group merged gave them', async () => {
    const alice = await signedIn('alice.merge.leave@example.test', 'Alice');
    const bob = await signedIn('bob.merge.leave@example.test', 'Bob');
    const flat = await createGroup(alice.token, 'Flat');
    const trip = await createGroup(alice.token, 'Trip');
    await join(alice.token, trip, bob.token);
    expect((await recordBetween(alice.token, trip, 1000, [alice.id, bob.id])).status).toBe('SUCCESS');
    expect((await merge(alice.token, flat, trip)).status).toBe('SUCCESS');
    const rows = await eventually(
      async () => (await http.get(`${api}/groups/${flat}/balances`, { token: alice.token })).body as Balance[],
      list => list.some(row => row.memberId === bob.id && row.balance !== 0),
    );
    const bobBalance = rows.find(row => row.memberId === bob.id)?.balance ?? 0;
    expect(bobBalance).not.toBe(0);

    // Groups asks Ledger for Bob's balance when he leaves, and the balance passes to the owner in the same step: the audit says so.
    const leave = await answered(http.request('POST', `${api}/groups/${flat}/leave`, { token: bob.token }), bob.token);
    expect(leave.status).toBe('SUCCESS');
    const audit = (await http.get(`${api}/groups/${flat}/audit`, { token: alice.token })).body as {
      action: string;
      subjectId: string;
      amount: number;
    }[];
    expect(audit.filter(entry => entry.action === 'balance-passed' && entry.subjectId === bob.id)).toEqual([
      expect.objectContaining({ amount: bobBalance }),
    ]);
  });

  it('Settlements → Groups (WaitingPayments): a payment waiting at the provider in the group merged keeps the merge from it', async () => {
    const alice = await signedIn('alice.merge.pay@example.test', 'Alice');
    const bob = await signedIn('bob.merge.pay@example.test', 'Bob');
    const flat = await createGroup(alice.token, 'Flat');
    const trip = await createGroup(alice.token, 'Trip');
    await join(alice.token, trip, bob.token);
    expect((await recordBetween(alice.token, trip, 1000, [alice.id, bob.id])).status).toBe('SUCCESS');

    // Alice is paid through the provider; Bob pays her 500 there and the payment waits, so the group merged may not be merged.
    const payout = await http.request('PUT', `${api}/accounts/me/payout-account`, {
      token: alice.token,
      body: { accountId: `payout_${alice.id}` },
    });
    expect(payout.status).toBe(202);
    const paid = await answered(
      http.request('POST', `${api}/groups/${trip}/settlements/provider`, {
        token: bob.token,
        body: { to: alice.id, amount: 500 },
      }),
      bob.token,
    );
    expect(paid.status).toBe('SUCCESS');

    expect((await merge(alice.token, flat, trip)).error?.type).toBe('MergeWaitsForPayment');
    expect((await http.get(`${api}/groups/${trip}`, { token: alice.token })).status).toBe(200);
  });
});
