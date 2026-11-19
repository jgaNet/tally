import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const SECRET = 'delete-relationship-secret';

/** A stand-in for the payment provider, so a settlement can wait at it (request 13): it answers a payment with an id and a link. */
let provider: Server;
let counter = 0;
let lastProviderId = '';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/accounts/acct-')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: decodeURIComponent((req.url ?? '').slice('/accounts/'.length)) }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/payments') {
        res.writeHead(404).end();
        return;
      }
      counter++;
      lastProviderId = `del-${counter}`;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: lastProviderId, payUrl: `https://pay.example/${lastProviderId}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;

  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const probeSignUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'delete-rel-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((probeSignUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(async () => {
  await app.stop();
  provider.close();
});

type Body = Record<string, unknown>;

/** Follows an operation to its outcome, as a client does. */
async function outcome(operationId: string, token?: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    if (status !== 200 || (body as Body).status !== 'PENDING') return { status, body: body as Body };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

/** Asks for a command and follows it to its outcome: the operation's body. */
async function command(method: string, path: string, token: string, body?: unknown): Promise<Body> {
  const answer = await http.request(method, `${api}${path}`, { body, token });
  if (answer.status !== 202) return { status: 'REFUSED', code: answer.status, body: answer.body as Body };
  return (await outcome((answer.body as Body).operationId as string, token)).body;
}

let accountCount = 0;

async function person(name: string, payoutAccount?: string) {
  const email = `${name.toLowerCase()}-delete-rel-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  const id = (me.body as { id: string }).id;
  if (payoutAccount) await command('PUT', '/accounts/me/payout-account', token, { accountId: payoutAccount });
  return { token, id };
}

/** A group `owner` creates and `member` joins, and the id Groups answered for it. */
async function pair(owner: { token: string }, member: { token: string }) {
  const created = await command('POST', '/groups', owner.token, { name: 'Flat', currency: 'EUR' });
  const groupId = (created.result as { id: string }).id;
  const invitation = await command('POST', `/groups/${groupId}/invitations`, owner.token);
  await command('POST', `/invitations/${(invitation.result as { id: string }).id}/accept`, member.token);
  return groupId;
}

async function expense(groupId: string, payer: { token: string }, between: string[], amount = 100) {
  return command('POST', `/groups/${groupId}/expenses`, payer.token, {
    description: 'Dinner',
    amount,
    date: serverToday,
    splitBetween: between,
  });
}

describe('Groups → Ledger (GroupMembers): an account Groups deletes stays in the group Groups made, and is in no new split Ledger keeps', () => {
  it('keeps its expense and its balance by the ids it had, and refuses it in a new split', async () => {
    const ann = await person('Ann');
    const cy = await person('Cy');
    const groupId = await pair(ann, cy);
    const dinner = await expense(groupId, cy, [cy.id, ann.id]);
    const expenseId = (dinner.result as { id: string }).id;

    expect((await command('DELETE', '/accounts/me', cy.token)).status).toBe('SUCCESS');

    const kept = await http.get(`${api}/expenses/${expenseId}`, { token: ann.token });
    expect(kept.body).toMatchObject({ id: expenseId, groupId, paidBy: cy.id });
    const balances = (await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.find(entry => entry.memberId === cy.id)?.balance).toBe(50);
    expect(balances.reduce((sum, entry) => sum + entry.balance, 0)).toBe(0);

    const refused = await expense(groupId, ann, [ann.id, cy.id]);
    expect((refused.error as { type: string }).type).toBe('AccountDeleted');
    const audit = await http.get(`${api}/groups/${groupId}/audit`, { token: ann.token });
    expect((audit.body as { by: string }[]).map(entry => entry.by)).toEqual([cy.id]);
  });
});

describe('Groups → Settlements (SettlementMembers): an account Groups deletes is paid through no provider and netted with no one, but may be paid back in cash', () => {
  it('refuses the provider and the netting by the rule, and keeps the cash settlement by its id', async () => {
    const ann = await person('Ann', 'acct-ann-del');
    const cy = await person('Cy', 'acct-cy-del');
    const groupId = await pair(ann, cy);
    expect((await expense(groupId, ann, [ann.id, cy.id])).status).toBe('SUCCESS');
    expect((await command('DELETE', '/accounts/me', cy.token)).status).toBe('SUCCESS');

    const provided = await command('POST', `/groups/${groupId}/settlements/provider`, cy.token, {
      to: ann.id,
      amount: 10,
    });
    expect(provided.code).toBe(401);
    const reversed = await expense(groupId, ann, [ann.id]);
    expect(reversed.status).toBe('SUCCESS');
    const netting = await command('POST', '/nettings', ann.token, { with: cy.id, currency: 'EUR' });
    expect((netting.error as { type: string }).type).toBe('AccountDeleted');

    const cash = await command('POST', `/groups/${groupId}/settlements/cash`, ann.token, { from: cy.id, amount: 50 });
    expect(cash.status).toBe('SUCCESS');
    const settlementId = (cash.result as { id: string }).id;
    const read = await http.get(`${api}/settlements/${settlementId}`, { token: ann.token });
    expect(read.body).toMatchObject({ id: settlementId, groupId, from: cy.id, to: ann.id, amount: 50, status: 'paid' });
  });

  it('refuses a payment through the provider to a deleted account', async () => {
    const ann = await person('Ann', 'acct-ann-del2');
    const cy = await person('Cy', 'acct-cy-del2');
    const groupId = await pair(ann, cy);
    expect((await expense(groupId, cy, [cy.id, ann.id])).status).toBe('SUCCESS');
    expect((await command('DELETE', '/accounts/me', cy.token)).status).toBe('SUCCESS');
    const paid = await command('POST', `/groups/${groupId}/settlements/provider`, ann.token, { to: cy.id, amount: 10 });
    expect((paid.error as { type: string }).type).toBe('AccountDeleted');
    const kept = await http.get(`${api}/groups/${groupId}/settlements`, { token: ann.token });
    expect(kept.body).toEqual([]);
  });
});

describe('Settlements → Groups (WaitingPayments): a payment Settlements keeps at the provider is one Groups reads, by the account it answers', () => {
  it('refuses the deletion while a payment waits at the provider, and allows it once the provider says it failed', async () => {
    const ann = await person('Ann', 'acct-ann-wait');
    const cy = await person('Cy');
    const groupId = await pair(ann, cy);
    expect((await expense(groupId, ann, [ann.id, cy.id])).status).toBe('SUCCESS');
    const paid = await command('POST', `/groups/${groupId}/settlements/provider`, cy.token, { to: ann.id, amount: 10 });
    expect(paid.status).toBe('SUCCESS');
    const settlementId = (paid.result as { id: string }).id;

    const refused = await command('DELETE', '/accounts/me', cy.token);
    expect((refused.error as { type: string }).type).toBe('PaymentWaitingAtProvider');
    expect((await http.get(`${api}/accounts/me`, { token: cy.token })).status).toBe(200);

    const payload = { id: `wh-${lastProviderId}`, paymentId: lastProviderId, status: 'failed' };
    const delivered = await http.request('POST', `${api}/provider/webhooks`, {
      body: payload,
      headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex') },
    });
    expect(delivered.status).toBeLessThan(300);
    const settlement = await http.get(`${api}/settlements/${settlementId}`, { token: ann.token });
    expect((settlement.body as Body).status).toBe('failed');

    expect((await command('DELETE', '/accounts/me', cy.token)).status).toBe('SUCCESS');
  });
});
