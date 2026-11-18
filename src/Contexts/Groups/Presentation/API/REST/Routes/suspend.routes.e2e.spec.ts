import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Suspending a member, end to end (request 34): the application booted in this process, spoken to over HTTP, every answer held to
 * api/34-suspend-a-member.yaml by the client. The administrator is the email the server is started with; the provider is a fake one.
 */
const SECRET = 'whsec_suspend';
const PASSWORD = 'correct horse';
const ROOT_EMAIL = 'root.suspend@example.com';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let provider: Server;
/** The payments the fake provider issued, in order: the last one is the payment a test made. */
const issued: string[] = [];

beforeAll(async () => {
  provider = createServer((req: IncomingMessage, res: ServerResponse) => {
    let text = '';
    req.on('data', chunk => (text += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.startsWith('/accounts/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ id: decodeURIComponent(req.url.slice('/accounts/'.length)) }));
      }
      issued.push(`pay_suspend_${issued.length + 1}`);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ id: issued[issued.length - 1], payUrl: `https://provider.test/pay/${issued.length}`, fee: 0 }),
      );
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ROOT_EMAIL;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  delete process.env.ADMIN_EMAILS;
});

type Person = { token: string; id: string };

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<Person> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group the owner founds, with each of the others invited and joined. Answers the group's id. */
async function groupOf(owner: Person, others: Person[], name: string): Promise<string> {
  const created = await http.request('POST', '/v1/groups', { body: { name, currency: 'EUR' }, token: owner.token });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: other.token,
    });
  }
  return groupId;
}

const expenseBy = (groupId: string, payer: Person, splitBetween: string[], amount: number) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount, date: '2020-01-02', splitBetween },
    token: payer.token,
  });
const cashFrom = (groupId: string, payee: Person, from: string, amount: number) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/cash`, { body: { from, amount }, token: payee.token });
const providerFrom = (groupId: string, payer: Person, to: string, amount: number) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/provider`, { body: { to, amount }, token: payer.token });
const balancesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];

const suspend = (accountId: string, token?: string) =>
  http.request('PUT', `/v1/admin/accounts/${accountId}/suspension`, { token });
const reinstate = (accountId: string, token?: string) =>
  http.request('DELETE', `/v1/admin/accounts/${accountId}/suspension`, { token });
const adminLog = async (token: string) =>
  (await http.get('/v1/admin/log', { token })).body as { id: string; action: string; subjectId: string; by: string }[];

const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh_${paymentId}_${status}`, at: '2026-11-17T10:00:00Z', paymentId, status };
  return http.request('POST', '/v1/provider/webhooks', {
    body,
    headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex') },
  });
};

describe('Suspending an account', () => {
  it('is answered by its id to an administrator, refuses its five changes by AccountSuspended in every group, and writes nothing in them', async () => {
    const root = await accountOf(ROOT_EMAIL, 'Root');
    const ana = await accountOf('ana.suspend@example.com', 'Ana');
    const ben = await accountOf('ben.suspend@example.com', 'Ben');
    const group = await groupOf(ana, [ben], 'The flat for suspension');
    expect((await expenseBy(group, ana, [ana.id, ben.id], 60)).status).toBe(201);
    const before = await balancesOf(group, ana.token);

    const answered = await suspend(ben.id, root.token);
    expect(answered.status).toBe(201);
    expect((answered.body as { id: string }).id).toBe(ben.id);

    const expense = await expenseBy(group, ben, [ana.id, ben.id], 10);
    expect(expense.status).toBe(409);
    expect(expense.body).toMatchObject({ type: 'AccountSuspended' });
    const cash = await cashFrom(group, ben, ana.id, 10);
    expect(cash.status).toBe(409);
    expect(cash.body).toMatchObject({ type: 'AccountSuspended' });
    const provider = await providerFrom(group, ben, ana.id, 10);
    expect(provider.status).toBe(409);
    expect(provider.body).toMatchObject({ type: 'AccountSuspended' });
    const recurring = await http.request('POST', `/v1/groups/${group}/recurring`, {
      body: { description: 'Rent', amount: 100, startsOn: '2020-01-05', splitBetween: [ana.id, ben.id] },
      token: ben.token,
    });
    expect(recurring.status).toBe(409);
    expect(recurring.body).toMatchObject({ type: 'AccountSuspended' });

    // Nothing in the group moved: the balances are as they were before the suspension.
    expect(await balancesOf(group, ana.token)).toEqual(before);

    // What the others may still do is as before: Ana splits an expense with Ben, and records Ben's payment in cash.
    expect((await expenseBy(group, ana, [ana.id, ben.id], 20)).status).toBe(201);
    expect((await cashFrom(group, ana, ben.id, 5)).status).toBe(201);

    // Suspending again changes nothing, and writes no entry.
    const logged = (await adminLog(root.token)).length;
    expect((await suspend(ben.id, root.token)).status).toBe(201);
    expect((await adminLog(root.token)).length).toBe(logged);

    expect((await reinstate(ben.id, root.token)).status).toBe(201);
    expect((await expenseBy(group, ben, [ana.id, ben.id], 10)).status).toBe(201);
  });

  it('is refused to anyone who is not an administrator, and to no one at all', async () => {
    const ana = await accountOf('ana.notroot.suspend@example.com', 'Ana');
    const ben = await accountOf('ben.notroot.suspend@example.com', 'Ben');
    expect((await suspend(ben.id, ana.token)).status).toBe(403);
    expect((await reinstate(ben.id, ana.token)).status).toBe(403);
    expect((await suspend(ben.id)).status).toBe(401);
  });

  it('logs each suspension and reinstatement, oldest first, with the account as its subject', async () => {
    const root = await accountOf(ROOT_EMAIL, 'Root');
    const ana = await accountOf('ana.log.suspend@example.com', 'Ana');
    await suspend(ana.id, root.token);
    await reinstate(ana.id, root.token);

    const entries = (await adminLog(root.token)).filter(entry => entry.subjectId === ana.id);
    expect(entries.map(entry => entry.action)).toEqual(['suspended', 'reinstated']);
    expect(entries.every(entry => entry.by === root.id)).toBe(true);
  });
});

describe('Groups → Ledger', () => {
  it('suspends an account in Groups, answers its id, and Ledger reads the member by that id, with the balance unchanged', async () => {
    const root = await accountOf(ROOT_EMAIL, 'Root');
    const ana = await accountOf('ana.ledger.suspend@example.com', 'Ana');
    const ben = await accountOf('ben.ledger.suspend@example.com', 'Ben');
    const group = await groupOf(ana, [ben], 'Ledger reads suspension');
    expect((await expenseBy(group, ana, [ana.id, ben.id], 60)).status).toBe(201);

    const answered = await suspend(ben.id, root.token);
    expect(answered.status).toBe(201);
    const suspendedId = (answered.body as { id: string }).id;
    expect(suspendedId).toBe(ben.id);

    const balances = await balancesOf(group, ana.token);
    expect(balances).toEqual(
      expect.arrayContaining([expect.objectContaining({ memberId: suspendedId, balance: -30 })]),
    );
    expect((await expenseBy(group, ben, [ana.id, ben.id], 10)).body).toMatchObject({ type: 'AccountSuspended' });
  });
});

describe('Groups → Settlements', () => {
  it('suspends an account in Groups, and Settlements lists a cash settlement the others record from it by its id', async () => {
    const root = await accountOf(ROOT_EMAIL, 'Root');
    const ana = await accountOf('ana.settle.suspend@example.com', 'Ana');
    const ben = await accountOf('ben.settle.suspend@example.com', 'Ben');
    const group = await groupOf(ana, [ben], 'Settlements reads suspension');
    expect((await expenseBy(group, ana, [ana.id, ben.id], 60)).status).toBe(201);

    const answered = await suspend(ben.id, root.token);
    expect(answered.status).toBe(201);
    const suspendedId = (answered.body as { id: string }).id;

    const recorded = await cashFrom(group, ana, suspendedId, 30);
    expect(recorded.status).toBe(201);
    const settlementId = (recorded.body as { id: string }).id;

    const listed = (await http.get(`/v1/groups/${group}/settlements`, { token: ana.token })).body as {
      id: string;
      from: string;
      status: string;
    }[];
    expect(listed).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: settlementId, from: suspendedId, status: 'paid' })]),
    );
  });
});

describe('Settlements → Groups', () => {
  it("pays through the provider in Settlements, the administrator decides it, and the administrators' log finds the decision by the settlement id", async () => {
    const root = await accountOf(ROOT_EMAIL, 'Root');
    const ana = await accountOf('ana.decide.suspend@example.com', 'Ana');
    const ben = await accountOf('ben.decide.suspend@example.com', 'Ben');
    expect(
      (
        await http.request('PUT', '/v1/accounts/me/payout-account', {
          body: { accountId: 'acct_ana_suspend' },
          token: ana.token,
        })
      ).status,
    ).toBeLessThan(300);
    const group = await groupOf(ana, [ben], 'Log reads decisions');
    expect((await expenseBy(group, ana, [ana.id, ben.id], 60)).status).toBe(201);

    const asked = await providerFrom(group, ben, ana.id, 30);
    expect(asked.status).toBe(201);
    const settlementId = (asked.body as { id: string }).id;
    await webhook(issued[issued.length - 1], 'succeeded');
    expect((await http.request('POST', `/v1/settlements/${settlementId}/contest`, { token: ana.token })).status).toBe(
      201,
    );
    expect(
      (
        await http.request('POST', `/v1/admin/settlements/${settlementId}/decision`, {
          body: { paid: true },
          token: root.token,
        })
      ).status,
    ).toBeLessThan(300);

    const entries = await adminLog(root.token);
    expect(entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ subjectId: settlementId, action: 'decided-paid' })]),
    );
  });
});
