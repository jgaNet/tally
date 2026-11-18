import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Deleting an account, end to end (request 35): the application booted in this process, spoken to over HTTP, every answer held to
 * api/ by the client. The payment provider is a fake one in this process. One application per suite, shared by its tests in order.
 */
const SECRET = 'whsec_delete';
const PASSWORD = 'correct horse';

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
      issued.push(`pay_delete_${issued.length + 1}`);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ id: issued[issued.length - 1], payUrl: `https://provider.test/pay/${issued.length}`, fee: 0 }),
      );
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
});

type Person = { token: string; id: string; email: string };

/** Signs an account up and in, and answers its token, its id and its email. */
async function accountOf(email: string, name: string): Promise<Person> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id, email };
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

const deleteMe = (token?: string) => http.request('DELETE', '/v1/accounts/me', { token });
const signIn = (email: string) => http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
const members = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/members`, { token })).body as { memberId: string; name: string }[];
const balancesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/balances`, { token })).body as { memberId: string; balance: number }[];
const expenseBetween = (groupId: string, payer: Person, splitBetween: string[], amount: number) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount, date: '2026-01-10', splitBetween },
    token: payer.token,
  });
const setPayoutAccount = (token: string, accountId: string) =>
  http.request('PUT', '/v1/accounts/me/payout-account', { body: { accountId }, token });
const payThroughProvider = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/settlements/provider`, { body, token });
const webhook = (paymentId: string, status: string) => {
  const body = { id: `wh_${paymentId}_${status}`, at: '2026-11-17T10:00:00Z', paymentId, status };
  return http.request('POST', '/v1/provider/webhooks', {
    body,
    headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex') },
  });
};

describe('deleting an account', () => {
  it('refuses to delete an account that owns a group with another member, and changes nothing', async () => {
    const owner = await accountOf('owner.delete@example.com', 'Owner');
    const other = await accountOf('other.delete@example.com', 'Other');
    await groupOf(owner, [other], 'Owned with a member');

    const refused = await deleteMe(owner.token);
    expect(refused.status).toBe(409);
    expect((refused.body as { type: string }).type).toBe('OwnsGroupWithMembers');

    expect((await http.get('/v1/accounts/me', { token: owner.token })).status).toBe(200);
    expect((await signIn(owner.email)).status).toBe(200);
  });

  it('deletes an account, which then signs in with nothing, and whose token proves nothing', async () => {
    const ana = await accountOf('ana.delete@example.com', 'Ana');

    const deleted = await deleteMe(ana.token);
    expect(deleted.status).toBe(201);
    expect((deleted.body as { id: string }).id).toBe(ana.id);

    const login = await signIn(ana.email);
    expect(login.status).toBeGreaterThanOrEqual(400);
    expect((login.body as { token?: string }).token).toBeUndefined();

    expect((await http.get('/v1/accounts/me', { token: ana.token })).status).toBe(401);
  });

  it('frees the email of a deleted account for a new account, which is someone else', async () => {
    const before = await accountOf('reuse.delete@example.com', 'First');
    await deleteMe(before.token);

    const signedUp = await http.request('POST', '/v1/accounts', {
      body: { email: 'reuse.delete@example.com', password: PASSWORD, name: 'Second' },
    });
    expect(signedUp.status).toBe(201);
    const second = (signedUp.body as { id: string }).id;
    expect(second).not.toBe(before.id);

    const login = await signIn('reuse.delete@example.com');
    const token = (login.body as { token: string }).token;
    const me = await http.get('/v1/accounts/me', { token });
    expect(me.body as { id: string; name: string }).toMatchObject({ id: second, name: 'Second' });
  });
});

describe('Groups → Ledger', () => {
  it('deletes a member of a group in Groups, answered by the id it was born with, and Ledger keeps its balance under that id, refusing new splits with it', async () => {
    const gus = await accountOf('gus.delete.ledger@example.com', 'Gus');
    const hal = await accountOf('hal.delete.ledger@example.com', 'Hal');
    const groupId = await groupOf(gus, [hal], 'Kept balances');
    expect((await expenseBetween(groupId, hal, [gus.id, hal.id], 1000)).status).toBe(201);

    const deleted = await deleteMe(hal.token);
    expect(deleted.status).toBe(201);
    expect((deleted.body as { id: string }).id).toBe(hal.id);

    const listed = await members(groupId, gus.token);
    expect(listed.find(member => member.memberId === hal.id)?.name).toBe('Deleted account');
    expect(listed.every(member => member.name !== 'Hal')).toBe(true);

    const balances = await balancesOf(groupId, gus.token);
    expect(balances.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
    expect(balances.find(row => row.memberId === hal.id)).toBeDefined();

    const refused = await expenseBetween(groupId, gus, [gus.id, hal.id], 500);
    expect(refused.status).toBe(409);
    expect((refused.body as { type: string }).type).toBe('AccountDeleted');
    expect((await expenseBetween(groupId, gus, [gus.id], 500)).status).toBe(201);
  });
});

describe('Groups → Settlements', () => {
  it('deletes a member in Groups, and Settlements refuses a payment through the provider to that id', async () => {
    const owner = await accountOf('owner.delete.settle@example.com', 'Owner');
    const payer = await accountOf('payer.delete.settle@example.com', 'Payer');
    const payee = await accountOf('payee.delete.settle@example.com', 'Payee');
    const groupId = await groupOf(owner, [payer, payee], 'Settled after deletion');
    expect((await expenseBetween(groupId, owner, [owner.id, payer.id, payee.id], 90)).status).toBe(201);

    expect((await deleteMe(payee.token)).status).toBe(201);

    const refused = await payThroughProvider(groupId, payer.token, { to: payee.id, amount: 10 });
    expect(refused.status).toBe(409);
    expect((refused.body as { type: string }).type).toBe('AccountDeleted');
  });
});

describe('Settlements → Groups', () => {
  it('pays through the provider in Settlements, and Groups refuses the deletion of the payee while the payment waits, then allows it once it has succeeded', async () => {
    const owner = await accountOf('owner.delete.provider@example.com', 'Owner');
    const payer = await accountOf('payer.delete.provider@example.com', 'Payer');
    const payee = await accountOf('payee.delete.provider@example.com', 'Payee');
    const groupId = await groupOf(owner, [payer, payee], 'Paid through the provider');
    expect((await expenseBetween(groupId, payee, [owner.id, payer.id, payee.id], 90)).status).toBe(201);
    expect((await setPayoutAccount(payee.token, 'acct_delete_payee')).status).toBeLessThan(300);

    const asked = await payThroughProvider(groupId, payer.token, { to: payee.id, amount: 30 });
    expect(asked.status).toBe(201);
    const paymentId = issued[issued.length - 1];

    const refused = await deleteMe(payee.token);
    expect(refused.status).toBe(409);
    expect((refused.body as { type: string }).type).toBe('PaymentWaiting');

    expect((await webhook(paymentId, 'succeeded')).status).toBeGreaterThanOrEqual(200);
    const allowed = await deleteMe(payee.token);
    expect(allowed.status).toBe(201);
    expect((allowed.body as { id: string }).id).toBe(payee.id);
  });
});
