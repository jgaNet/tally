import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let serverToday: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const signUp = await http.request('POST', `${api}/accounts`, {
    body: { email: 'delete-clock@example.com', password: 'correct horse', name: 'Clock' },
  });
  const probe = await outcome((signUp.body as Body).operationId as string);
  serverToday = String((probe.body as { createdAt: string }).createdAt).slice(0, 10);
});

afterAll(() => app.stop());

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

/** Signs up and in a new account: its token, its id, its email and its password. */
async function person(name: string, email?: string) {
  const address = email ?? `${name.toLowerCase()}-delete-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email: address, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email: address, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, email: address, password, name };
}

/** A group of two: `owner` created it, `member` joined it. */
async function pair(owner: { token: string }, member: { token: string }) {
  const created = await command('POST', '/groups', owner.token, { name: 'Flat', currency: 'EUR' });
  const groupId = (created.result as { id: string }).id;
  const invitation = await command('POST', `/groups/${groupId}/invitations`, owner.token);
  await command('POST', `/invitations/${(invitation.result as { id: string }).id}/accept`, member.token);
  return groupId;
}

describe('Deleting an account (request 35)', () => {
  it('refuses while the account owns a group that has another member, and changes nothing', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    await pair(ann, bob);

    const refused = await command('DELETE', '/accounts/me', ann.token);
    expect(refused.status).toBe('ERROR');
    expect((refused.error as { type: string }).type).toBe('AccountOwnsAGroupWithMembers');

    const login = await http.request('POST', `${api}/accounts/login`, {
      body: { email: ann.email, password: ann.password },
    });
    expect(login.status).toBe(200);
    expect((await http.get(`${api}/accounts/me`, { token: ann.token })).status).toBe(200);
  });

  it('answers 401 to a caller who is not signed in', async () => {
    expect((await http.request('DELETE', `${api}/accounts/me`)).status).toBe(401);
  });

  it('is gone as a person, erased everywhere, and still a member with its balance', async () => {
    const ann = await person('Ann');
    const cy = await person('Cy Unique-Name', 'cy-delete-unique@example.com');
    const groupId = await pair(ann, cy);
    const solo = await command('POST', '/groups', cy.token, { name: 'Mine', currency: 'EUR' });
    expect(solo.status).toBe('SUCCESS');
    const expense = await command('POST', `/groups/${groupId}/expenses`, cy.token, {
      description: 'Groceries',
      amount: 30,
      date: serverToday,
      splitBetween: [cy.id, ann.id],
    });
    expect(expense.status).toBe('SUCCESS');
    const expenseId = (expense.result as { id: string }).id;
    // Ann then pays more than Cy did, so that Cy owes 15 when its account is deleted.
    const dinner = await command('POST', `/groups/${groupId}/expenses`, ann.token, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [cy.id, ann.id],
    });
    expect(dinner.status).toBe('SUCCESS');
    const balancesBefore = (await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body;
    const membersBefore = (await http.get(`${api}/groups/${groupId}/members`, { token: ann.token })).body as Body[];

    const deleted = await command('DELETE', '/accounts/me', cy.token);
    expect(deleted.status).toBe('SUCCESS');

    // Gone as a person: nobody signs in with it, and the token it had proves nothing.
    const login = await http.request('POST', `${api}/accounts/login`, {
      body: { email: cy.email, password: cy.password },
    });
    expect(login.status).toBe(401);
    expect((await http.get(`${api}/accounts/me`, { token: cy.token })).status).toBe(401);
    expect((await http.request('DELETE', `${api}/accounts/me`, { token: cy.token })).status).toBe(401);

    // Its balances are kept: it stays a member at its place, named `Deleted account`, and the balances add up to 0.
    const members = (await http.get(`${api}/groups/${groupId}/members`, { token: ann.token })).body as Body[];
    expect(members.map(member => member.memberId)).toEqual(membersBefore.map(member => member.memberId));
    expect(members.map(member => member.role)).toEqual(membersBefore.map(member => member.role));
    expect(members.find(member => member.memberId === cy.id)?.name).toBe('Deleted account');
    expect(members.find(member => member.memberId === ann.id)?.name).toBe('Ann');
    const balances = (await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      balance: number;
    }[];
    expect(balances).toEqual(balancesBefore);
    expect(balances.reduce((sum, entry) => sum + entry.balance, 0)).toBe(0);
    const read = await http.get(`${api}/expenses/${expenseId}`, { token: ann.token });
    expect((read.body as Body).paidBy).toBe(cy.id);

    // What can no longer happen to it: a new split with it, the provider, a netting; a recorded expense may still be settled in cash.
    const split = await command('POST', `/groups/${groupId}/expenses`, ann.token, {
      description: 'Bread',
      amount: 10,
      date: serverToday,
      splitBetween: [cy.id, ann.id],
    });
    expect(split.status).toBe('ERROR');
    expect((split.error as { type: string }).type).toBe('AccountDeleted');
    const alone = await command('POST', `/groups/${groupId}/expenses`, ann.token, {
      description: 'Bread',
      amount: 10,
      date: serverToday,
      splitBetween: [ann.id],
    });
    expect(alone.status).toBe('SUCCESS');
    const provider = await command('POST', `/groups/${groupId}/settlements/provider`, ann.token, {
      to: cy.id,
      amount: 5,
    });
    expect(provider.status === 'ERROR' || provider.status === 'REFUSED').toBe(true);
    const net = await command('POST', '/nettings', ann.token, { with: cy.id, currency: 'EUR' });
    expect(net.status).toBe('ERROR');
    expect((net.error as { type: string }).type).toBe('AccountDeleted');
    const cash = await command('POST', `/groups/${groupId}/settlements/cash`, ann.token, { from: cy.id, amount: 15 });
    expect(cash.status).toBe('SUCCESS');
    const after = (await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      balance: number;
    }[];
    expect(after.reduce((sum, entry) => sum + entry.balance, 0)).toBe(0);

    // Its email may be used by a new account, which is someone else.
    const again = await person('Cy Again', 'cy-delete-unique@example.com');
    expect(again.id).not.toBe(cy.id);
    expect((await http.get(`${api}/accounts/me`, { token: again.token })).body).toMatchObject({ name: 'Cy Again' });
  });
});
