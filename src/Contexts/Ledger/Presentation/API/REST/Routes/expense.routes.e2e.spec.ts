import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Expenses, end to end: the application booted in this process on a free port, spoken to over HTTP, every answer held
 * to api/4-record-an-expense.yaml by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
/** A day long spent, and one no clock will reach: the rule against a day after today is held by the domain. */
const SPENT = '2020-01-02';
const FUTURE = '9999-12-31';

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by `owner`, which each of `others` joins by an invitation: the group's id. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    const joined = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token });
    expect(joined.status).toBe(201);
  }
  return groupId;
}

const record = (groupId: string, token: string | undefined, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, { body, token });
const readExpense = (id: string, token?: string) => http.get(`/v1/expenses/${id}`, { token });

describe('Groups → Ledger', () => {
  it('splits an expense between members of a group made through the API, and reads it by the id it was answered', async () => {
    const ana = await accountOf('ana.split@example.com', 'Ana');
    const ben = await accountOf('ben.split@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const recorded = await record(groupId, ana.token, {
      description: 'Groceries',
      amount: 1000,
      date: SPENT,
      splitBetween: [ben.id, ana.id],
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;

    const read = await readExpense(expenseId, ben.token);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      id: expenseId,
      groupId,
      amount: 1000,
      paidBy: ana.id,
      shares: [
        { memberId: ben.id, amount: 500 },
        { memberId: ana.id, amount: 500 },
      ],
    });
  });
});

describe('recording an expense', () => {
  it('gives the remainder to the payer, so the shares add up to the amount', async () => {
    const ana = await accountOf('ana.remainder@example.com', 'Ana');
    const ben = await accountOf('ben.remainder@example.com', 'Ben');
    const groupId = await groupWith(ana, [ben]);

    const recorded = await record(groupId, ana.token, {
      description: 'Taxi',
      amount: 1001,
      date: SPENT,
      splitBetween: [ben.id, ana.id],
    });
    const read = await readExpense((recorded.body as { id: string }).id, ana.token);

    expect(read.body).toMatchObject({
      shares: [
        { memberId: ben.id, amount: 500 },
        { memberId: ana.id, amount: 501 },
      ],
    });
  });

  it('refuses a split with someone who is not a member, listed twice, or without the payer', async () => {
    const ana = await accountOf('ana.split-refusals@example.com', 'Ana');
    const ben = await accountOf('ben.split-refusals@example.com', 'Ben');
    const stranger = await accountOf('stranger.split-refusals@example.com', 'Stranger');
    const groupId = await groupWith(ana, [ben]);
    const base = { description: 'Dinner', amount: 900, date: SPENT };

    const withStranger = await record(groupId, ana.token, { ...base, splitBetween: [ana.id, stranger.id] });
    const twice = await record(groupId, ana.token, { ...base, splitBetween: [ana.id, ben.id, ben.id] });
    const withoutPayer = await record(groupId, ana.token, { ...base, splitBetween: [ben.id] });

    expect(withStranger.status).toBe(400);
    expect(withStranger.body).toMatchObject({ type: 'SplitWithStranger' });
    expect(twice.status).toBe(400);
    expect(twice.body).toMatchObject({ type: 'SplitListsTwice' });
    expect(withoutPayer.status).toBe(400);
    expect(withoutPayer.body).toMatchObject({ type: 'SplitWithoutPayer' });
  });

  it('refuses a description that is only spaces, an amount out of range, and a day not yet spent', async () => {
    const ana = await accountOf('ana.values@example.com', 'Ana');
    const groupId = await groupWith(ana, []);
    const base = { description: 'Coffee', amount: 300, date: SPENT, splitBetween: [ana.id] };

    const blank = await record(groupId, ana.token, { ...base, description: '     ' });
    const zero = await record(groupId, ana.token, { ...base, amount: 0 });
    const fraction = await record(groupId, ana.token, { ...base, amount: 2.5 });
    const tooMuch = await record(groupId, ana.token, { ...base, amount: 100_000_001 });
    const future = await record(groupId, ana.token, { ...base, date: FUTURE });
    const notADay = await record(groupId, ana.token, { ...base, date: '2025-02-30' });

    expect(blank.body).toMatchObject({ type: 'InvalidExpenseDescription' });
    expect(zero.body).toMatchObject({ type: 'InvalidAmount' });
    expect(tooMuch.body).toMatchObject({ type: 'InvalidAmount' });
    expect(fraction.status).toBe(400);
    expect(future.body).toMatchObject({ type: 'InvalidExpenseDate' });
    expect(notADay.body).toMatchObject({ type: 'InvalidExpenseDate' });
    for (const answer of [blank, zero, tooMuch, future, notADay]) expect(answer.status).toBe(400);
  });

  it('refuses a body missing a field, and a caller who is not signed in', async () => {
    const ana = await accountOf('ana.shape-expense@example.com', 'Ana');
    const groupId = await groupWith(ana, []);

    const missing = await record(groupId, ana.token, { description: 'Bread', amount: 100 });
    const anonymous = await record(groupId, undefined, {
      description: 'Bread',
      amount: 100,
      date: SPENT,
      splitBetween: [ana.id],
    });

    expect(missing.status).toBe(400);
    expect(anonymous.status).toBe(401);
  });

  it('answers a group that is not the caller’s as if it did not exist', async () => {
    const ana = await accountOf('ana.outsider@example.com', 'Ana');
    const eve = await accountOf('eve.outsider@example.com', 'Eve');
    const groupId = await groupWith(ana, []);

    const answer = await record(groupId, eve.token, {
      description: 'Sneaky',
      amount: 100,
      date: SPENT,
      splitBetween: [eve.id],
    });

    expect(answer.status).toBe(404);
  });
});

describe('reading an expense', () => {
  it('is answered to a member of its group only, as if it did not exist for anyone else', async () => {
    const ana = await accountOf('ana.read@example.com', 'Ana');
    const eve = await accountOf('eve.read@example.com', 'Eve');
    const groupId = await groupWith(ana, []);
    const recorded = await record(groupId, ana.token, {
      description: 'Rent share',
      amount: 400,
      date: SPENT,
      splitBetween: [ana.id],
    });
    const expenseId = (recorded.body as { id: string }).id;

    const asMember = await readExpense(expenseId, ana.token);
    const asOther = await readExpense(expenseId, eve.token);
    const anonymous = await readExpense(expenseId);
    const unknown = await readExpense('no-such-expense', ana.token);

    expect(asMember.status).toBe(200);
    expect(asMember.body).toMatchObject({ description: 'Rent share', date: SPENT, paidBy: ana.id });
    expect(asOther.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(unknown.status).toBe(404);
  });
});
