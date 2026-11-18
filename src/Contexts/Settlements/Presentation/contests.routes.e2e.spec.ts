import { createHmac, randomUUID } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('contests');

const WEBHOOK_SECRET = 'a-shared-secret-with-the-provider';
/** The administrators, as the server is started with them: the list is comma-separated, and an email's case does not matter (request 33). */
const ADMIN_EMAILS = 'Root@Example.com, ops@example.com';

/** The payment provider, as a server of its own: it answers `POST /payments` with a link, and the accounts it is asked about. */
let paymentCount = 0;
let providerServer: Server;

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise(resolve => {
    let text = '';
    request.on('data', chunk => (text += chunk));
    request.on('end', () => resolve(text));
  });

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
/** The administrator, signed up and signed in once, as anyone does (request 33): the server names its email as an administrator's. */
let root: { token: string; id: string };

beforeAll(async () => {
  providerServer = createServer(async (request, response) => {
    await readBody(request);
    const path = request.url ?? '';
    if (request.method === 'POST' && path === '/payments') {
      paymentCount += 1;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `pay-${paymentCount}`, payUrl: `https://pay.example/pay-${paymentCount}` }));
      return;
    }
    if (request.method === 'GET' && /^\/accounts\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.slice('/accounts/'.length));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;

  process.env.PROVIDER_URL = providerOrigin;
  process.env.PROVIDER_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.ADMIN_EMAILS = ADMIN_EMAILS;
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  root = await signedIn('Root@Example.com', 'Root');
});
afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => providerServer.close(() => resolve()));
  delete process.env.PROVIDER_URL;
  delete process.env.PROVIDER_WEBHOOK_SECRET;
  delete process.env.ADMIN_EMAILS;
});

const PASSWORD = 'a-good-password';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as Array<{
    memberId: string;
    balance: number;
  }>;

const readSettlement = (id: string, token: string) => http.request('GET', `${api}/settlements/${id}`, { token });

const contest = (id: string, token: string) => http.request('POST', `${api}/settlements/${id}/contest`, { token });

const decide = (id: string, paid: boolean, token: string) =>
  http.request('POST', `${api}/admin/settlements/${id}/decision`, { body: { paid }, token });

/** The provider's webhook, signed as the provider signs it: HMAC-SHA256 of the body as sent, in lowercase hexadecimal. */
async function webhook(payload: { paymentId: string; status: string }): Promise<number> {
  const body = JSON.stringify({ id: randomUUID(), at: '2026-11-17T10:00:00Z', ...payload });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  const response = await fetch(`${app.address}${api}/provider/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
    body,
  });
  return response.status;
}

/** Ann paid 100 for herself and Bob, so Bob owes Ann 50; Bob pays Ann 50 through the provider, and the provider says it succeeded. */
async function paidThroughProvider(label: string) {
  const ann = await signedIn(`${label}-ann@example.com`, 'Ann');
  const bob = await signedIn(`${label}-bob@example.com`, 'Bob');
  const groupId = await groupWith(ann, [bob]);
  // Ann is paid through the provider, so she has a payout account at it (request 16).
  await http.request('PUT', `${api}/accounts/me/payout-account`, {
    body: { accountId: `acct-${ann.id}` },
    token: ann.token,
  });
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Lunch', amount: 100, date: '2026-01-15', splitBetween: [ann.id, bob.id] },
    token: ann.token,
  });
  const created = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: ann.id, amount: 50 },
    token: bob.token,
  });
  const id = (created.body as { id: string }).id;
  expect(await webhook({ paymentId: `pay-${paymentCount}`, status: 'succeeded' })).toBe(204);
  return { groupId, ann, bob, id, paymentId: `pay-${paymentCount}` };
}

/** The administrator of every test below. */
const administrator = async () => root;

describe('contesting a settlement paid through the payment provider', () => {
  it('holds it: the balances are as they were before it was paid, it is contested, and an administrator lists it', async () => {
    const { groupId, ann, bob, id } = await paidThroughProvider('contest-held');
    const root = await administrator();
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);

    expect((await contest(id, ann.token)).status).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ id, status: 'contested' });
    expect(((await readSettlement(id, bob.token)).body as { history: unknown[] }).history).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'contested' })]),
    );
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 50 },
      { memberId: bob.id, balance: -50 },
    ]);

    const contests = (await http.request('GET', `${api}/admin/contests`, { token: root.token })).body as Array<{
      id: string;
    }>;
    expect(contests.map(each => each.id)).toContain(id);
  });

  it('refuses a contest by anyone but its payee, and a second one for the same settlement', async () => {
    const { ann, bob, id } = await paidThroughProvider('contest-refused');
    expect((await contest(id, bob.token)).status).toBe(403);
    expect((await contest(id, ann.token)).status).toBe(204);
    expect((await contest(id, ann.token)).status).toBe(422);
  });

  it('a decision that the money arrived counts the settlement as it did before, and both are in the audit and the log', async () => {
    const { groupId, ann, bob, id } = await paidThroughProvider('decided-paid');
    const root = await administrator();
    await contest(id, ann.token);

    expect((await decide(id, true, root.token)).status).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ id, status: 'paid' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);

    const audit = (await http.request('GET', `${api}/groups/${groupId}/audit`, { token: ann.token })).body as Array<{
      action: string;
      by: string;
      subjectId: string;
      amount: number;
    }>;
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'settlement-contested', by: ann.id, subjectId: id, amount: 50 }),
        expect.objectContaining({ action: 'settlement-paid', by: root.id, subjectId: id, amount: 50 }),
      ]),
    );

    const log = (await http.request('GET', `${api}/admin/log`, { token: root.token })).body as Array<{
      action: string;
      by: string;
      subjectId: string;
    }>;
    expect(log).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'decided-paid', by: root.id, subjectId: id })]),
    );
  });

  it('a decision that the money did not arrive annuls the settlement, and what was owed is owed again', async () => {
    const { groupId, ann, bob, id } = await paidThroughProvider('decided-annulled');
    const root = await administrator();
    await contest(id, ann.token);

    expect((await decide(id, false, root.token)).status).toBe(204);
    expect((await readSettlement(id, bob.token)).body).toMatchObject({ id, status: 'annulled' });
    expect(await balancesOf(groupId, ann.token)).toEqual([
      { memberId: ann.id, balance: 50 },
      { memberId: bob.id, balance: -50 },
    ]);
    // Only a contested settlement is decided, once: an annulled one is decided no more, and is not contested again.
    expect((await decide(id, true, root.token)).status).toBe(422);
    expect((await contest(id, ann.token)).status).toBe(422);

    const log = (await http.request('GET', `${api}/admin/log`, { token: root.token })).body as Array<{
      action: string;
      subjectId: string;
    }>;
    expect(log).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'decided-annulled', subjectId: id })]),
    );
  });

  it('never changes a contested settlement from the provider: a webhook about its payment changes nothing', async () => {
    const { ann, id, paymentId } = await paidThroughProvider('contest-webhook');
    await contest(id, ann.token);

    expect(await webhook({ paymentId, status: 'refunded' })).toBe(204);
    expect(await webhook({ paymentId, status: 'failed' })).toBe(204);
    expect((await readSettlement(id, ann.token)).body).toMatchObject({ id, status: 'contested' });
  });

  it('lists the settlements contested now, the earliest contested first', async () => {
    const first = await paidThroughProvider('order-first');
    const second = await paidThroughProvider('order-second');
    const root = await administrator();
    // The second is contested before the first: the list answers it first, not in the order the settlements were made.
    await contest(second.id, second.ann.token);
    await contest(first.id, first.ann.token);

    const ids = (
      (await http.request('GET', `${api}/admin/contests`, { token: root.token })).body as Array<{ id: string }>
    )
      .map(each => each.id)
      .filter(each => each === first.id || each === second.id);
    expect(ids).toEqual([second.id, first.id]);
  });

  it('is read and decided by administrators only: for anyone else the lists do not exist and a decision is refused', async () => {
    const { ann, id } = await paidThroughProvider('admin-only');
    await contest(id, ann.token);

    expect((await http.request('GET', `${api}/admin/contests`, { token: ann.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/admin/log`, { token: ann.token })).status).toBe(404);
    expect((await decide(id, true, ann.token)).status).toBe(403);
    expect((await http.request('GET', `${api}/admin/log`)).status).toBe(401);
    expect((await decide(id, true, '')).status).toBe(401);
  });
});

describe('Groups → Settlements', () => {
  it('reads the settlements of a group made in Groups, by the id the group was answered', async () => {
    const owner = await signedIn('groups-settlements-owner@example.com', 'Owner');
    const group = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: owner.token,
    });
    const groupId = (group.body as { id: string }).id;

    const read = await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: owner.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual([]);
  });
});

describe('Settlements → Groups (AdministratorDecisions)', () => {
  it("finds, in the administrators' log Groups answers, the decision made about the settlement made in Settlements, by its id", async () => {
    const { ann, id } = await paidThroughProvider('log-by-id');
    const root = await administrator();
    await contest(id, ann.token);
    await decide(id, true, root.token);

    const log = (await http.request('GET', `${api}/admin/log`, { token: root.token })).body as Array<{
      subjectId: string;
    }>;
    expect(log.filter(each => each.subjectId === id)).toHaveLength(1);
  });
  it('answers, in the same log, the changes Groups made to accounts beside the decisions, the oldest first', async () => {
    const { ann, id } = await paidThroughProvider('log-order');
    const root = await administrator();
    const suspended = await signedIn('log-order-suspended@example.com', 'Suspended');
    await http.request('PUT', `${api}/admin/accounts/${suspended.id}/suspension`, { token: root.token });
    await contest(id, ann.token);
    await decide(id, true, root.token);

    const log = (await http.request('GET', `${api}/admin/log`, { token: root.token })).body as Array<{
      at: string;
      action: string;
      subjectId: string;
    }>;
    const ours = log.filter(each => each.subjectId === id || each.subjectId === suspended.id);
    expect(ours.map(each => each.action)).toEqual(['suspended', 'decided-paid']);
    expect(ours.map(each => each.at)).toEqual([...ours.map(each => each.at)].sort());
  });
});
