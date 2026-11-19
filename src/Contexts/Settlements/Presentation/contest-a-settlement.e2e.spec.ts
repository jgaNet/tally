import { createHmac } from 'crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabaseUrl } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 33 over HTTP: the payee of a settlement paid through the provider contests it; the balances stop counting it, yet it waits
 * (what is still owed counts it, nobody leaves, archives or merges) until an administrator decides it was paid or annuls it. Every
 * decision is an entry of the administrators' log.
 */
const SECRET = 'a shared secret for the test';

/** A fake provider: payments are created with the next id; refunds are answered with `refundAnswer` and every one it got is kept. */
let provider: Server;
let received: { reference: string; amount: number; currency: string }[] = [];
let refunds: { paymentId: string; reference: string }[] = [];

let server: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    // The provider knows every account asked about (request 16): a `GET /accounts/{id}` answers `200 { id }`.
    if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
      return;
    }
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const json = body === '' ? {} : JSON.parse(body);
      if (request.url === '/payments') {
        received = [...received, json as { reference: string; amount: number; currency: string }];
        const id = `pay_${received.length}`;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, fee: 0, payUrl: `https://pay.example/${id}` }));
        return;
      }
      const match = /^\/payments\/([^/]+)\/refunds$/.exec(request.url ?? '');
      if (match) {
        refunds = [...refunds, { paymentId: decodeURIComponent(match[1]), reference: json.reference }];
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `rf_${refunds.length}` }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  process.env.DATABASE_URL = await freshDatabaseUrl();
  process.env.PROVIDER_URL = providerOrigin;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL.toUpperCase() + ', other-admin@example.org';

  server = await createApplication();
  await server.start(0);
  http = apiClient(server.address);
  api = `/${server.apiPrefix}`;
});

afterAll(async () => {
  await server.stop();
  await new Promise(resolve => provider.close(resolve));
});

let accountCount = 0;
const PASSWORD = 'a long password';
const ADMIN_EMAIL = 'root@example.org';

interface Person {
  id: string;
  email: string;
  token: string;
}

async function signedInPerson(name: string): Promise<Person> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  const id = (created.body as { id: string }).id;
  const token = (login.body as { token: string }).token;
  await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId: `acct_${id}` }, token });
  return { id, email, token };
}

/** A group of an owner and two members who joined, with an expense of 60 split between the owner and `grace`: `grace` owes 30. */
async function groupWhereGraceOwes30() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const linus = await signedInPerson('Linus');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  for (const person of [grace, linus]) {
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
    token: ada.token,
  });
  return { ada, grace, linus, groupId };
}

/** Asks to pay Ada the 30 Grace owes through the provider; answers the settlement's id and the provider's id for its payment. */
async function askToPay(groupId: string, graceToken: string, adaId: string, amount = 30) {
  const asked = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
    body: { to: adaId, amount },
    token: graceToken,
  });
  expect(asked.status).toBe(201);
  const { id } = asked.body as { id: string };
  expect(received.at(-1)).toMatchObject({ reference: id, amount });
  return { id, paymentId: `pay_${received.length}` };
}

/** A webhook as the provider sends it: the body as JSON, signed with the shared secret over exactly those bytes. */
const sendWebhook = (webhookId: string, paymentId: string, status: string) => {
  const body = { id: webhookId, paymentId, status, at: '2026-01-02T10:00:00Z' };
  const signature = createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
  return http.request('POST', `${api}/provider/webhooks`, {
    body,
    headers: { 'content-type': 'application/json', 'provider-signature': signature },
  });
};

const contest = (id: string, token: string | undefined) =>
  http.request('POST', `${api}/settlements/${id}/contest`, token === undefined ? {} : { token });

const decide = (id: string, paid: unknown, token: string | undefined) =>
  http.request('POST', `${api}/admin/settlements/${id}/decision`, {
    body: { paid },
    ...(token === undefined ? {} : { token }),
  });

let administratorToken: string | undefined;
/** The administrator: an account signed up as anyone does, whose email the server was started with, in another case. */
async function administrator(): Promise<{ id: string; token: string }> {
  if (administratorToken === undefined) {
    await http.request('POST', `${api}/accounts`, { body: { email: ADMIN_EMAIL, password: PASSWORD, name: 'Root' } });
  }
  const login = await http.request('POST', `${api}/accounts/login`, {
    body: { email: ADMIN_EMAIL, password: PASSWORD },
  });
  administratorToken = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token: administratorToken });
  return { id: (me.body as { id: string }).id, token: administratorToken };
}

const settlementOf = async (id: string, token: string) =>
  (await http.request('GET', `${api}/settlements/${id}`, { token })).body as {
    status: string;
    history: { status: string; at: string }[];
  };

const auditOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/audit`, { token })).body as {
    by: string;
    action: string;
    subjectId: string;
    amount: number;
  }[];

const balancesOf = async (groupId: string, token: string) =>
  (
    (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
      memberId: string;
      balance: number;
    }[]
  ).reduce<Record<string, number>>((all, row) => ({ ...all, [row.memberId]: row.balance }), {});

/** A settlement of 30 Grace paid Ada through the provider, paid at the provider's word. */
async function paidSettlement() {
  const group = await groupWhereGraceOwes30();
  const { id, paymentId } = await askToPay(group.groupId, group.grace.token, group.ada.id);
  expect((await sendWebhook(`evt_paid_${id}`, paymentId, 'succeeded')).status).toBe(204);
  return { ...group, id, paymentId };
}

describe('Contest a settlement (request 33)', () => {
  it('holds a contested settlement until an administrator decides it was paid', async () => {
    const { ada, grace, linus, groupId, id, paymentId } = await paidSettlement();
    const root = await administrator();

    // Only the payee contests it, and only when signed in.
    expect((await contest(id, undefined)).status).toBe(401);
    expect((await contest(id, grace.token)).status).toBe(403);
    expect((await contest(id, ada.token)).status).toBe(204);
    expect(await settlementOf(id, grace.token)).toMatchObject({ status: 'contested' });

    // The balances do not count it any more, but what is still owed does: nobody may owe it again by a second payment.
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });
    expect(
      (await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: linus.token })).body,
    ).toEqual([]);
    const again = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 1 },
      token: ada.token,
    });
    expect(again.status).toBe(400);

    // Once only; and neither its payer nor its payee leaves the group, nor is it archived, while it waits.
    const twice = await contest(id, ada.token);
    expect(twice.status).toBe(400);
    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token })).status).toBe(400);
    expect((await http.request('POST', `${api}/groups/${groupId}/archive`, { token: ada.token })).status).toBe(400);

    // A webhook about its payment changes nothing.
    expect((await sendWebhook('evt_refunded_late', paymentId, 'refunded')).status).toBe(204);
    expect(await settlementOf(id, grace.token)).toMatchObject({ status: 'contested' });

    // Only an administrator reads what is contested, and decides.
    expect((await http.request('GET', `${api}/admin/contests`, { token: ada.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/admin/contests`, {})).status).toBe(401);
    const listed = await http.request('GET', `${api}/admin/contests`, { token: root.token });
    expect(listed.status).toBe(200);
    expect((listed.body as { id: string }[]).map(each => each.id)).toContain(id);
    expect((await decide(id, true, ada.token)).status).toBe(403);
    expect((await decide(id, true, undefined)).status).toBe(401);
    expect((await decide(id, 'yes', root.token)).status).toBe(400);
    expect((await decide(id, true, root.token)).status).toBe(204);

    // Paid again, as before it was contested; decided once.
    expect(await settlementOf(id, grace.token)).toMatchObject({ status: 'paid' });
    expect((await settlementOf(id, grace.token)).history.map(line => line.status)).toEqual([
      'pending',
      'paid',
      'contested',
      'paid',
    ]);
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
    expect((await decide(id, false, root.token)).status).toBe(400);
    expect(
      ((await http.request('GET', `${api}/admin/contests`, { token: root.token })).body as { id: string }[]).map(
        each => each.id,
      ),
    ).not.toContain(id);
    // Contested once, even when it was paid again.
    expect((await contest(id, ada.token)).status).toBe(400);

    // The audit says it was contested by its payee, and paid by the administrator.
    const audit = (await auditOf(groupId, linus.token)).filter(entry => entry.subjectId === id);
    expect(audit.map(entry => [entry.action, entry.by, entry.amount])).toEqual([
      ['settlement-paid', grace.id, 30],
      ['settlement-contested', ada.id, 30],
      ['settlement-paid', root.id, 30],
    ]);

    // It is in the administrators' log, which only they read.
    expect((await http.request('GET', `${api}/admin/log`, { token: ada.token })).status).toBe(404);
    expect((await http.request('GET', `${api}/admin/log`, {})).status).toBe(401);
    const log = (await http.request('GET', `${api}/admin/log`, { token: root.token })).body as {
      id: string;
      by: string;
      action: string;
      subjectId: string;
    }[];
    expect(log.filter(entry => entry.subjectId === id)).toEqual([
      expect.objectContaining({ by: root.id, action: 'decided-paid', subjectId: id }),
    ]);
  });

  it('annuls a settlement an administrator decides was not paid, and what was owed is owed again', async () => {
    const { ada, grace, linus, groupId, id } = await paidSettlement();
    const root = await administrator();
    expect((await contest(id, ada.token)).status).toBe(204);
    expect((await decide(id, false, root.token)).status).toBe(204);

    expect(await settlementOf(id, grace.token)).toMatchObject({ status: 'annulled' });
    expect((await settlementOf(id, grace.token)).history.map(line => line.status)).toEqual([
      'pending',
      'paid',
      'contested',
      'annulled',
    ]);
    // Nothing counts it any more, and it no longer waits: Grace owes 30 again, and may leave nothing behind her.
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });
    expect(
      (await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: linus.token })).body,
    ).toEqual([{ from: grace.id, to: ada.id, amount: 30 }]);

    // No audit entry of its own, and the log says it.
    expect((await auditOf(groupId, linus.token)).map(entry => entry.action)).toEqual([
      'expense-recorded',
      'settlement-paid',
      'settlement-contested',
    ]);
    const log = (await http.request('GET', `${api}/admin/log`, { token: root.token })).body as {
      at: string;
      by: string;
      action: string;
      subjectId: string;
    }[];
    expect(log.at(-1)).toMatchObject({ by: root.id, action: 'decided-annulled', subjectId: id });
    expect(Number.isNaN(Date.parse(log.at(-1)?.at ?? ''))).toBe(false);
  });

  it('refuses a settlement that is not paid through the provider, and one who is not its payee', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const cash = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 10 },
      token: ada.token,
    });
    expect((await contest((cash.body as { id: string }).id, ada.token)).status).toBe(400);

    // Pending at the provider, it is not paid yet.
    const { id } = await askToPay(groupId, grace.token, ada.id, 20);
    const pending = await contest(id, ada.token);
    expect(pending.status).toBe(400);
    expect(pending.body).toMatchObject({ type: 'SettlementNotPaid' });
    expect(await settlementOf(id, grace.token)).toMatchObject({ status: 'pending' });

    // A member who is neither is refused, and anyone who is not a member finds nothing.
    expect((await contest(id, linus.token)).status).toBe(403);
    const stranger = await signedInPerson('Stranger');
    expect((await contest(id, stranger.token)).status).toBe(404);
    expect((await contest('unknown', ada.token)).status).toBe(404);
    const root = await administrator();
    expect((await decide('unknown', true, root.token)).status).toBe(404);
    // A settlement that is not contested is not decided.
    expect((await decide(id, true, root.token)).status).toBe(400);
  });

  it('lists the contests, the earliest contested first', async () => {
    const first = await paidSettlement();
    const second = await paidSettlement();
    const root = await administrator();
    expect((await contest(second.id, second.ada.token)).status).toBe(204);
    expect((await contest(first.id, first.ada.token)).status).toBe(204);

    const listed = (await http.request('GET', `${api}/admin/contests`, { token: root.token })).body as {
      id: string;
      status: string;
    }[];
    const ids = listed.map(each => each.id);
    expect(ids.indexOf(second.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(listed.every(each => each.status === 'contested')).toBe(true);
    expect((await decide(second.id, true, root.token)).status).toBe(204);
    expect((await decide(first.id, false, root.token)).status).toBe(204);
  });

  it('makes no administrator of anyone but the accounts the server was started with', async () => {
    const ada = await signedInPerson('Ada');
    expect((await http.request('GET', `${api}/admin/contests`, { token: ada.token })).status).toBe(404);
    // A token cannot be given a role by changing it.
    const forged = `${ada.token.split('.').slice(0, 2).join('.')}.administrator.${ada.token.split('.')[2]}`;
    expect((await http.request('GET', `${api}/admin/contests`, { token: forged })).status).toBe(401);
  });
});

describe('Groups → Settlements', () => {
  it('refuses to contest a settlement in a group Groups archived, found by the id it answered, and keeps it paid', async () => {
    const { ada, grace, groupId, id } = await paidSettlement();
    // The balances are 0 and nothing waits, so the owner archives the group the settlement was made in.
    expect((await http.request('POST', `${api}/groups/${groupId}/archive`, { token: ada.token })).status).toBe(204);

    const refused = await contest(id, ada.token);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'GroupArchived' });
    expect(await settlementOf(id, grace.token)).toMatchObject({ status: 'paid' });
  });
});

describe('Settlements → Groups', () => {
  it('refuses the merge of a group whose settlement is contested, and the administrators log is read through Groups by the settlement id', async () => {
    const { ada, grace, groupId, id } = await paidSettlement();
    const other = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Annex', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    expect((await contest(id, ada.token)).status).toBe(204);

    const refused = await http.request('POST', `${api}/groups/${other.id}/merge`, {
      body: { from: groupId },
      token: ada.token,
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'PaymentsWaiting' });
    expect((await http.request('GET', `${api}/groups/${groupId}`, { token: grace.token })).status).toBe(200);

    // Decided, nothing waits any more: the log Groups answers names the settlement by the id its request answered.
    const root = await administrator();
    expect((await decide(id, false, root.token)).status).toBe(204);
    const log = (await http.request('GET', `${api}/admin/log`, { token: root.token })).body as {
      by: string;
      action: string;
      subjectId: string;
    }[];
    expect(log.find(entry => entry.subjectId === id)).toMatchObject({ by: root.id, action: 'decided-annulled' });
  });
});
