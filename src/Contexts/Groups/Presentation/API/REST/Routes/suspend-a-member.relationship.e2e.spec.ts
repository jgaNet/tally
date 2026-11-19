import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

const ADMIN_EMAIL = 'Suspend-Admin@Example.com';
const SECRET = 'shared-with-the-provider-for-suspensions';

/** A stand-in for the payment provider: it answers `201 { id, payUrl }` to a payment, and knows the accounts `acct-…`. */
let provider: Server;
let counter = 0;
let lastProviderId = '';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;
let admin: { token: string; id: string };

beforeAll(async () => {
  provider = createServer((req, res) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      if (req.method === 'GET' && /^\/accounts\/[^/]+$/.test(req.url ?? '')) {
        const accountId = decodeURIComponent((req.url ?? '').slice('/accounts/'.length));
        if (!accountId.startsWith('acct-')) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: accountId }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/payments') {
        res.writeHead(404).end();
        return;
      }
      counter++;
      lastProviderId = `prov-suspend-${counter}`;
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: lastProviderId, payUrl: `https://pay.example/${lastProviderId}`, fee: 0 }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  process.env.ADMIN_EMAILS = ADMIN_EMAIL.toLowerCase();
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const probeSignUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'suspend-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((probeSignUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
  admin = await person('Admin', ADMIN_EMAIL);
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

/** Signs up and in a new account; an administrator's email is one of ADMIN_EMAILS. */
async function person(name: string, email?: string) {
  const address = email ?? `suspend-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email: address, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email: address, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body.result as { id: string }).id;
  await command('POST', `/invitations/${invitationId}/accept`, joiner.token);
}

async function webhook(payload: Body) {
  return http.request('POST', `${api}/provider/webhooks`, {
    body: payload,
    headers: { 'provider-signature': createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex') },
  });
}

/** A group of two, created by `ann` with `bob` joined: the ids and the group. */
async function trio() {
  const ann = await person('Ann');
  const bob = await person('Bob');
  const created = await command('POST', '/groups', ann.token, { name: 'Flat', currency: 'EUR' });
  const groupId = (created.result as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationDone = await outcome((invitation.body as Body).operationId as string, ann.token);
  const invitationId = (invitationDone.body.result as { id: string }).id;
  await command('POST', `/invitations/${invitationId}/accept`, bob.token);
  return { ann, bob, groupId };
}

async function suspend(accountId: string) {
  return command('PUT', `/admin/accounts/${accountId}/suspension`, admin.token);
}

async function reinstate(accountId: string) {
  return command('DELETE', `/admin/accounts/${accountId}/suspension`, admin.token);
}

function expenseBody(bobId: string, annId: string) {
  return { description: 'Groceries', amount: 30, date: serverToday, splitBetween: [bobId, annId] };
}

describe('Suspending a member (request 34)', () => {
  it('lets only an administrator suspend and reinstate, and refuses anyone else', async () => {
    const { ann } = await trio();
    const asMember = await command('PUT', `/admin/accounts/${ann.id}/suspension`, ann.token);
    expect(asMember.status).toBe('ERROR');
    const asSuspended = await http.request('PUT', `${api}/admin/accounts/${ann.id}/suspension`);
    expect(asSuspended.status).toBe(401);
    expect((await suspend(ann.id)).status).toBe('SUCCESS');
    expect((await reinstate(ann.id)).status).toBe('SUCCESS');
  });

  it('refuses a suspended account every expense, cash settlement and netting, by the name of one rule, and changes nothing', async () => {
    const { ann, bob, groupId } = await trio();
    const before = await http.get(`${api}/groups/${groupId}/balances`, { token: bob.token });
    expect((await suspend(ann.id)).status).toBe('SUCCESS');

    const expense = await command('POST', `/groups/${groupId}/expenses`, ann.token, expenseBody(bob.id, ann.id));
    expect(expense.status).toBe('ERROR');
    expect((expense.error as { type: string }).type).toBe('AccountSuspended');

    const cash = await command('POST', `/groups/${groupId}/settlements/cash`, ann.token, { from: bob.id, amount: 5 });
    expect((cash.error as { type: string }).type).toBe('AccountSuspended');

    const netting = await command('POST', '/nettings', ann.token, { with: bob.id, currency: 'EUR' });
    expect((netting.error as { type: string }).type).toBe('AccountSuspended');

    const after = await http.get(`${api}/groups/${groupId}/balances`, { token: bob.token });
    expect(after.body).toEqual(before.body);
  });

  it('lets the others go on, and the suspended account still read and leave as before', async () => {
    const { ann, bob, groupId } = await trio();
    expect((await suspend(ann.id)).status).toBe('SUCCESS');

    const byBob = await command('POST', `/groups/${groupId}/expenses`, bob.token, expenseBody(bob.id, ann.id));
    expect(byBob.status).toBe('SUCCESS');
    const read = await http.get(`${api}/groups/${groupId}/expenses`, { token: ann.token });
    expect(read.status).toBe(200);

    expect((await reinstate(ann.id)).status).toBe('SUCCESS');
    const again = await command('POST', `/groups/${groupId}/expenses`, ann.token, expenseBody(bob.id, ann.id));
    expect(again.status).toBe('SUCCESS');
  });

  it('logs each suspension and each reinstatement, and no change that changes nothing', async () => {
    const { ann } = await trio();
    expect((await suspend(ann.id)).status).toBe('SUCCESS');
    expect((await suspend(ann.id)).status).toBe('SUCCESS');
    expect((await reinstate(ann.id)).status).toBe('SUCCESS');
    expect((await reinstate(ann.id)).status).toBe('SUCCESS');

    const log = await http.get(`${api}/admin/log`, { token: admin.token });
    expect(log.status).toBe(200);
    const entries = (log.body as { action: string; subjectId: string; by: string }[]).filter(
      entry => entry.subjectId === ann.id,
    );
    expect(entries.map(entry => entry.action)).toEqual(['suspended', 'reinstated']);
    expect(entries.every(entry => entry.by === admin.id)).toBe(true);
  });
});

describe('Groups → Ledger (GroupMembers): an account Groups suspends is refused the expense Ledger would keep, in the group the request answered', () => {
  it('is refused an expense in the group Groups made, by the rule, and Ledger keeps none', async () => {
    const ann = await person('LedgerAnn');
    const bob = await person('LedgerBob');
    const created = await command('POST', '/groups', ann.token, { name: 'Ledger link', currency: 'EUR' });
    const groupId = (created.result as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    const invitationId = (
      (await outcome((invitation.body as Body).operationId as string, ann.token)).body.result as {
        id: string;
      }
    ).id;
    await command('POST', `/invitations/${invitationId}/accept`, bob.token);

    expect((await suspend(ann.id)).status).toBe('SUCCESS');
    const refused = await command('POST', `/groups/${groupId}/expenses`, ann.token, expenseBody(bob.id, ann.id));
    expect((refused.error as { type: string }).type).toBe('AccountSuspended');

    const kept = await http.get(`${api}/groups/${groupId}/expenses`, { token: bob.token });
    expect(kept.body).toEqual([]);
    await reinstate(ann.id);
  });
});

describe('Groups → Settlements (SettlementMembers): an account Groups suspends starts no cash settlement in the group Groups made', () => {
  it('is refused a cash settlement by the rule, and Settlements keeps none', async () => {
    const ann = await person('SettleAnn');
    const bob = await person('SettleBob');
    const created = await command('POST', '/groups', ann.token, { name: 'Settle link', currency: 'EUR' });
    const groupId = (created.result as { id: string }).id;
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    const invitationId = (
      (await outcome((invitation.body as Body).operationId as string, ann.token)).body.result as {
        id: string;
      }
    ).id;
    await command('POST', `/invitations/${invitationId}/accept`, bob.token);

    expect((await suspend(bob.id)).status).toBe('SUCCESS');
    const refused = await command('POST', `/groups/${groupId}/settlements/cash`, bob.token, {
      from: ann.id,
      amount: 5,
    });
    expect((refused.error as { type: string }).type).toBe('AccountSuspended');

    const kept = await http.get(`${api}/groups/${groupId}/settlements`, { token: ann.token });
    expect(kept.body).toEqual([]);
    await reinstate(bob.id);
  });
});

describe('Settlements → Groups (AdministratorDecisions): a decision Settlements keeps is read in Groups log by the settlement it was about, beside the suspensions', () => {
  it('reads the decision Settlements made, by its settlement id, with the suspension Groups made', async () => {
    const ann = await person('LogAnn');
    await command('PUT', '/accounts/me/payout-account', ann.token, { accountId: `acct-${ann.id}` });
    const bob = await person('LogBob');
    const created = await command('POST', '/groups', ann.token, { name: 'Log link', currency: 'EUR' });
    const groupId = (created.result as { id: string }).id;
    await join(groupId, ann, bob);
    await command('POST', `/groups/${groupId}/expenses`, ann.token, expenseBody(bob.id, ann.id));

    // Settlements makes the settlement through the provider: the id is the one its operation answered.
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 10 },
      token: bob.token,
    });
    const settlementId = (
      (await outcome((paid.body as Body).operationId as string, bob.token)).body.result as {
        id: string;
      }
    ).id;
    await webhook({
      id: `wh-${lastProviderId}`,
      paymentId: lastProviderId,
      status: 'succeeded',
      at: '2026-11-17T10:00:00Z',
    });
    const contest = await http.request('POST', `${api}/settlements/${settlementId}/contest`, { token: ann.token });
    expect((await outcome((contest.body as Body).operationId as string, ann.token)).body.status).toBe('SUCCESS');

    // Settlements decides it, and Groups suspends an account: the log reads both, the oldest first.
    const decided = await http.request('POST', `${api}/admin/settlements/${settlementId}/decision`, {
      body: { paid: true },
      token: admin.token,
    });
    expect((await outcome((decided.body as Body).operationId as string, admin.token)).body.status).toBe('SUCCESS');
    expect((await suspend(bob.id)).status).toBe('SUCCESS');
    await reinstate(bob.id);

    const log = await http.get(`${api}/admin/log`, { token: admin.token });
    expect(log.status).toBe(200);
    const entries = log.body as { subjectId: string; by: string; action: string; at: string }[];
    expect(entries.filter(e => e.subjectId === settlementId)).toEqual([
      { id: expect.any(String), at: expect.any(String), by: admin.id, action: 'decided-paid', subjectId: settlementId },
    ]);
    const moments = entries.map(entry => entry.at);
    expect([...moments].sort()).toEqual(moments);
    expect(entries.filter(e => e.subjectId === bob.id).map(e => e.action)).toEqual(['suspended', 'reinstated']);
  });
});
