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
    body: { email: 'settle-cash-clock@example.com', password: 'correct horse', name: 'Clock' },
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

let accountCount = 0;

/** Signs up and in a new account, and answers its token and its id. */
async function person(name: string) {
  const email = `settle-cash-${name.toLowerCase()}-${++accountCount}@example.com`;
  const password = 'correct horse';
  const signUp = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  await outcome((signUp.body as Body).operationId as string);
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.get(`${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id };
}

/** Creates a group and answers its id, as a client does. */
async function createGroup(owner: { token: string }) {
  const answer = await http.request('POST', `${api}/groups`, {
    body: { name: 'Trip', currency: 'EUR' },
    token: owner.token,
  });
  const done = await outcome((answer.body as Body).operationId as string, owner.token);
  return (done.body as { result: { id: string } }).result.id;
}

/** A member of the group invites someone, who accepts: the new member joins. */
async function join(groupId: string, owner: { token: string }, joiner: { token: string }) {
  const created = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
  const invitation = await outcome((created.body as Body).operationId as string, owner.token);
  const invitationId = (invitation.body as { result: { id: string } }).result.id;
  const accepted = await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: joiner.token });
  await outcome((accepted.body as Body).operationId as string, joiner.token);
}

/** Records an expense the caller paid, and answers the expense's id, as the operation's result gives it. */
async function record(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
  const done = await outcome((answer.body as Body).operationId as string, token);
  return (done.body as { result?: { id: string } }).result?.id as string;
}

/** Records a cash settlement as the payee does, and follows it to its outcome. */
async function settleInCash(token: string, groupId: string, body: Body) {
  const answer = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body, token });
  if (answer.status !== 202) return { status: answer.status, body: answer.body as Body };
  const done = await outcome((answer.body as Body).operationId as string, token);
  return { status: done.body.status as string, body: done.body };
}

async function balances(groupId: string, token: string) {
  const { body } = await http.get(`${api}/groups/${groupId}/balances`, { token });
  return Object.fromEntries((body as { memberId: string; balance: number }[]).map(b => [b.memberId, b.balance]));
}

describe('Settlements: a settlement in cash is recorded by its payee, and the balances count it at once', () => {
  it('records what a member paid in cash, and the balances are even once it is', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });

    const settled = await settleInCash(ann.token, groupId, { from: bob.id, amount: 30 });
    expect(settled.status).toBe('SUCCESS');
    const id = (settled.body.result as { id: string }).id;

    expect(await balances(groupId, bob.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
    const read = await http.get(`${api}/settlements/${id}`, { token: bob.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      from: bob.id,
      to: ann.id,
      amount: 30,
      method: 'cash',
      status: 'paid',
      at: expect.any(String),
    });
  });

  it('refuses a settlement that pays more than is owed, and changes nothing', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });

    const tooMuch = await settleInCash(ann.token, groupId, { from: bob.id, amount: 31 });
    expect(tooMuch.status).toBe('ERROR');
    expect((tooMuch.body.error as { type: string }).type).toBe('SettlementExceedsDebt');
    const fromPayee = await settleInCash(ann.token, groupId, { from: ann.id, amount: 1 });
    expect((fromPayee.body.error as { type: string }).type).toBe('PayerIsPayee');
    const notAmount = await settleInCash(ann.token, groupId, { from: bob.id, amount: 0 });
    expect((notAmount.body.error as { type: string }).type).toBe('InvalidSettlementAmount');

    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 30, [bob.id]: -30 });
  });

  it('refuses a payer who is not a member of the group', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const stranger = await person('Stranger');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });

    const answer = await settleInCash(ann.token, groupId, { from: stranger.id, amount: 10 });
    expect((answer.body.error as { type: string }).type).toBe('PayerNotAMember');
  });

  it('decides two settlements recorded at the same moment one after the other: the second is refused', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });

    const [first, second] = await Promise.all([
      settleInCash(ann.token, groupId, { from: bob.id, amount: 30 }),
      settleInCash(ann.token, groupId, { from: bob.id, amount: 30 }),
    ]);
    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(['ERROR', 'SUCCESS']);
    expect(await balances(groupId, ann.token)).toEqual({ [ann.id]: 0, [bob.id]: 0 });
  });

  it('counts a settlement in leaving: a member who owed cannot leave, and one who was paid back can', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });

    const before = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect((await outcome((before.body as Body).operationId as string, bob.token)).body.status).toBe('ERROR');

    await settleInCash(ann.token, groupId, { from: bob.id, amount: 30 });
    const after = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: bob.token });
    expect((await outcome((after.body as Body).operationId as string, bob.token)).body.status).toBe('SUCCESS');
  });

  it('answers a settlement to a member of its group only, and to nobody else as not found', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const stranger = await person('Stranger');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });
    const settled = await settleInCash(ann.token, groupId, { from: bob.id, amount: 30 });
    const id = (settled.body.result as { id: string }).id;

    expect((await http.get(`${api}/settlements/${id}`, { token: bob.token })).status).toBe(200);
    expect((await http.get(`${api}/settlements/${id}`, { token: stranger.token })).status).toBe(404);
    expect((await http.get(`${api}/settlements/${id}`)).status).toBe(401);
    expect((await http.get(`${api}/settlements/does-not-exist`, { token: ann.token })).status).toBe(404);
  });
});

describe('Groups → Settlements (SettlementMembers): the group Groups makes is the one Settlements reads, by the id its request answered', () => {
  it('reads the group by the id its creation answered, for its members, and not for anyone else', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const stranger = await person('Stranger');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);

    expect((await http.get(`${api}/groups/${groupId}`, { token: ann.token })).status).toBe(200);
    const member = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: bob.token });
    expect(member.status).toBe(200);
    expect(member.body).toEqual([]);
    const other = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: stranger.token });
    expect(other.status).toBe(404);
  });
});

describe('Ledger → Settlements (GroupBalances): the expense Ledger records is the balance Settlements suggests from, by the id its request answered', () => {
  it('reads the expense by the id its request answered, and suggests the transfer that clears what it owes', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    const expenseId = await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });

    const expense = await http.get(`${api}/expenses/${expenseId}`, { token: bob.token });
    expect(expense.status).toBe(200);
    expect((expense.body as { id: string }).id).toBe(expenseId);
    const suggested = await http.get(`${api}/groups/${groupId}/settlements/suggested`, { token: bob.token });
    expect(suggested.body).toEqual([{ from: bob.id, to: ann.id, amount: 30 }]);
  });
});

describe('Settlements → Ledger (SettledAmounts): the settlement Settlements records is in the balances Ledger reads, by the id its request answered', () => {
  it('reads the settlement by the id its request answered, and the balances of its group count it', async () => {
    const ann = await person('Ann');
    const bob = await person('Bob');
    const groupId = await createGroup(ann);
    await join(groupId, ann, bob);
    await record(ann.token, groupId, {
      description: 'Dinner',
      amount: 60,
      date: serverToday,
      splitBetween: [ann.id, bob.id],
    });
    const settled = await settleInCash(ann.token, groupId, { from: bob.id, amount: 30 });
    const settlementId = (settled.body.result as { id: string }).id;

    const read = await http.get(`${api}/settlements/${settlementId}`, { token: ann.token });
    expect(read.status).toBe(200);
    expect((read.body as { id: string }).id).toBe(settlementId);
    expect(await balances((read.body as { groupId: string }).groupId, ann.token)).toEqual({
      [ann.id]: 0,
      [bob.id]: 0,
    });
  });
});
