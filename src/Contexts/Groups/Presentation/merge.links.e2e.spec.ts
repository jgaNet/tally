import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The relationships a merge of two groups crosses, over HTTP (feature 31, request 31): each thing is made in one context through the API,
 * its id is the one that request answered, and the other context finds it by that same id. Each relationship of the context map is named
 * by its title, so that the gate can see the test that holds it: Groups → Ledger and Groups → Settlements carry GroupsMerged, and a merge
 * is refused while a payment waits in the group merged (Settlements → Groups, WaitingPayments).
 */
let directory: string;
let provider: Server;
let providerUrl: string;
let paymentsByReference: Map<string, string>;
let nextPayment: number;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const SECRET = 'a secret Tally and the provider share';
const WEBHOOK_AT = '2026-03-01T10:00:00.000Z';
const PAST_DAY = '2020-01-15';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-merge-links-'));
  paymentsByReference = new Map();
  nextPayment = 0;
  // A fake payment provider on a local port: it keeps each payment by its reference, and knows the payout accounts `acct-…`.
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    const account = /^\/accounts\/([^/]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && account) {
      const known = decodeURIComponent(account[1]).startsWith('acct-');
      res.statusCode = known ? 200 : 404;
      res.setHeader('content-type', 'application/json');
      res.end(known ? JSON.stringify({ id: decodeURIComponent(account[1]) }) : '{}');
      return;
    }
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      const body = JSON.parse(text) as { reference: string };
      nextPayment += 1;
      const id = `pay-${nextPayment}`;
      paymentsByReference.set(body.reference, id);
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  app = await createApplication({
    databaseUrl: await freshDatabase(),
    logger: silent,
    providerUrl,
    providerWebhookSecret: SECRET,
  });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann-links@example.com');
  bob = await person('Bob', 'bob-links@example.com');
});
afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    token,
    body: { accountId: `acct-${name.toLowerCase()}` },
  });
  return { token, id: (me.body as { id: string }).id };
}

type Person = Awaited<ReturnType<typeof person>>;
let ann: Person;
let bob: Person;

/** A group of Ann's, made through the API: the id the request answered is the one the tests keep. */
const createGroup = async (name: string): Promise<string> => {
  const { body } = await http.request('POST', `${api}/groups`, { token: ann.token, body: { name, currency: 'EUR' } });
  return (body as { id: string }).id;
};
const joinGroup = async (groupId: string, who: Person) => {
  const invited = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invited.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};
const merge = (token: string, groupId: string, from: string) =>
  http.request('POST', `${api}/groups/${groupId}/merge`, { token, body: { from } });

/** Reads what a test waits for, again and again, until it holds or the polls run out: the reaction runs soon after the merge. */
async function eventually<T>(read: () => Promise<T>, holds: (value: T) => boolean, polls = 200): Promise<T> {
  let value = await read();
  for (let poll = 0; poll < polls && !holds(value); poll++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describe('Groups → Ledger (GroupsMerged)', () => {
  it('moves the expenses of the group merged to the group kept, which Ledger reads by the id Groups answered', async () => {
    const kept = await createGroup('Kept');
    const merged = await createGroup('Merged');
    await joinGroup(kept, bob);
    await joinGroup(merged, bob);
    const recorded = await http.request('POST', `${api}/groups/${merged}/expenses`, {
      token: ann.token,
      body: { description: 'Milk', amount: 400, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    const expenseId = (recorded.body as { id: string }).id;

    expect(await merge(ann.token, kept, merged)).toMatchObject({ status: 204 });

    const listed = await eventually(
      async () =>
        (
          (await http.request('GET', `${api}/groups/${kept}/expenses`, { token: ann.token })).body as {
            id: string;
            groupId: string;
          }[]
        ).find(expense => expense.id === expenseId),
      expense => expense?.groupId === kept,
    );
    expect(listed).toMatchObject({ id: expenseId, groupId: kept });
  });
});

describe('Groups → Settlements (GroupsMerged)', () => {
  it('moves the settlements of the group merged to the group kept, which Settlements lists by the id Groups answered', async () => {
    const kept = await createGroup('Kept settled');
    const merged = await createGroup('Merged settled');
    await joinGroup(merged, bob);
    await http.request('POST', `${api}/groups/${merged}/expenses`, {
      token: ann.token,
      body: { description: 'Dinner', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    // Bob pays Ann his 500 in cash, recorded by Ann as its payee.
    const cash = await http.request('POST', `${api}/groups/${merged}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, to: ann.id, amount: 500 },
    });
    expect(cash.status).toBeLessThan(300);
    const settlementId = (cash.body as { id: string }).id;

    expect(await merge(ann.token, kept, merged)).toMatchObject({ status: 204 });

    const listed = await eventually(
      async () =>
        (
          (await http.request('GET', `${api}/groups/${kept}/settlements`, { token: ann.token })).body as {
            id: string;
            groupId: string;
          }[]
        ).find(settlement => settlement.id === settlementId),
      settlement => settlement?.groupId === kept,
    );
    expect(listed).toMatchObject({ id: settlementId, groupId: kept, status: 'paid' });
  });
});

describe('Settlements → Groups (WaitingPayments)', () => {
  it('refuses a merge while a payment through the provider in the group merged waits, and merges once it has ended', async () => {
    const kept = await createGroup('Kept waiting');
    const merged = await createGroup('Merged waiting');
    await joinGroup(merged, bob);
    await http.request('POST', `${api}/groups/${merged}/expenses`, {
      token: ann.token,
      body: { description: 'Rent', amount: 1000, date: PAST_DAY, splitBetween: [ann.id, bob.id] },
    });
    // Bob pays Ann 500 through the provider: pending until the provider says it succeeded.
    const paid = await http.request('POST', `${api}/groups/${merged}/settlements/provider`, {
      token: bob.token,
      body: { to: ann.id, amount: 500 },
    });
    expect(paid.status).toBeLessThan(300);
    const settlementId = (paid.body as { id: string }).id;

    expect(await merge(ann.token, kept, merged)).toMatchObject({ status: 422 });
    expect((await http.request('GET', `${api}/groups/${merged}`, { token: ann.token })).status).toBe(200);

    const webhook = {
      id: `wh-${settlementId}`,
      paymentId: paymentsByReference.get(settlementId),
      status: 'succeeded',
      at: WEBHOOK_AT,
    };
    const counted = await http.request('POST', `${api}/provider/webhooks`, {
      body: webhook,
      headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(webhook)).digest('hex') },
    });
    expect(counted.status).toBe(204);

    expect(await merge(ann.token, kept, merged)).toMatchObject({ status: 204 });
    expect((await http.request('GET', `${api}/groups/${merged}`, { token: ann.token })).status).toBe(404);
  });
});
