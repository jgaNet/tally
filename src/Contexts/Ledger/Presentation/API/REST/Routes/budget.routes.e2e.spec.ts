import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Budgets, end to end (request 24): the application booted in this process, spoken to over HTTP, every answer held to
 * api/24-budgets.yaml by the client. The outbox relay and the background job run at the composition root's interval, which this
 * test sets short, so a passed budget's notices come while the test waits for them. The day is the server's, as its own Date header says.
 */
const PASSWORD = 'correct horse';

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;

beforeAll(async () => {
  app = await createApplication({ jobsIntervalSeconds: 0.05 });
  await app.start(0);
  http = apiClient(app.address);
});

afterAll(async () => {
  await app.stop();
});

async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

let counter = 0;
const uniqueEmail = (name: string) => `${name}.${++counter}.${Math.random().toString(36).slice(2)}@example.com`;

/** The server's today, from its own Date header: the test reads no clock of its own. */
async function todayOf(token: string): Promise<Date> {
  const answer = await http.get('/v1/accounts/me', { token });
  return new Date(answer.headers.get('date') ?? '');
}

/** A EUR group of two: the owner, and a member who joined it. */
async function groupOfTwo(): Promise<{
  owner: { token: string; id: string };
  other: { token: string; id: string };
  groupId: string;
}> {
  const owner = await accountOf(uniqueEmail('owner'), 'Ana');
  const other = await accountOf(uniqueEmail('other'), 'Ben');
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
  await http.request('POST', `/v1/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: other.token,
  });
  return { owner, other, groupId };
}

/** Waits, over HTTP, until `check` answers true: the outbox and the job run at the interval the test set. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The notices did not arrive in time');
}

const setBudget = (groupId: string, category: string, token: string | undefined, amount: number) =>
  http.request('PUT', `/v1/groups/${groupId}/budgets/${category}`, { body: { amount }, token });
const removeBudget = (groupId: string, category: string, token: string) =>
  http.request('DELETE', `/v1/groups/${groupId}/budgets/${category}`, { token });
const budgetsOf = (groupId: string, token: string) => http.get(`/v1/groups/${groupId}/budgets`, { token });
const record = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/expenses`, { body, token });
const noticesOf = async (token: string) =>
  (await http.get('/v1/notices', { token })).body as { kind: string; [key: string]: unknown }[];

describe('Ledger: budgets (request 24)', () => {
  it('is set and removed by the owner alone, and read by a member in the order of the categories', async () => {
    const { owner, other, groupId } = await groupOfTwo();

    expect(await setBudget(groupId, 'rent', owner.token, 90_000)).toMatchObject({
      status: 201,
      body: { id: expect.any(String) },
    });
    expect(await setBudget(groupId, 'groceries', owner.token, 40_000)).toMatchObject({ status: 201 });
    expect(await setBudget(groupId, 'groceries', other.token, 1)).toMatchObject({
      status: 403,
      body: { type: 'NotAllowed' },
    });
    expect((await setBudget(groupId, 'groceries', undefined, 1)).status).toBe(401);
    expect((await setBudget(groupId, 'sweets', owner.token, 1)).status).toBe(400);

    expect(await budgetsOf(groupId, other.token)).toMatchObject({
      status: 200,
      body: [
        { category: 'groceries', amount: 40_000, spent: 0 },
        { category: 'rent', amount: 90_000, spent: 0 },
      ],
    });

    expect((await removeBudget(groupId, 'rent', other.token)).status).toBe(403);
    expect((await removeBudget(groupId, 'rent', owner.token)).status).toBe(201);
    expect((await budgetsOf(groupId, other.token)).body).toEqual([{ category: 'groceries', amount: 40_000, spent: 0 }]);
  });

  it('tells every member, the payer too, once when a month passes a budget, and counts only its own category', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    expect((await setBudget(groupId, 'groceries', owner.token, 40_000)).status).toBe(201);
    const date = (await todayOf(owner.token)).toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    const split = { splitBetween: [owner.id, other.id] };

    const shop = await record(groupId, owner.token, {
      description: 'Shop',
      date,
      amount: 30_000,
      category: 'groceries',
      ...split,
    });
    expect(shop.status).toBe(201);
    const rent = await record(groupId, owner.token, { description: 'Flat', date, amount: 15_000, ...split });
    expect(rent.status).toBe(201);
    expect(await http.get(`/v1/expenses/${(rent.body as { id: string }).id}`, { token: owner.token })).toMatchObject({
      body: { category: 'other' },
    });

    // Groceries are at 30 000 against a budget of 40 000: no notice yet.
    expect(await budgetsOf(groupId, other.token)).toMatchObject({
      body: [{ category: 'groceries', amount: 40_000, spent: 30_000 }],
    });
    expect(
      await record(groupId, owner.token, {
        description: 'Market',
        date,
        amount: 15_000,
        category: 'groceries',
        ...split,
      }),
    ).toMatchObject({
      status: 201,
    });

    // 45 000 is more than 40 000: each member is told once.
    const passing = { kind: 'budget', groupId, category: 'groceries', month, budget: 40_000, amount: 45_000 };
    for (const member of [owner, other]) {
      await eventually(async () => (await noticesOf(member.token)).some(notice => notice.kind === 'budget'));
      const budgetNotices = (await noticesOf(member.token)).filter(notice => notice.kind === 'budget');
      expect(budgetNotices).toEqual([{ id: expect.any(String), at: expect.any(String), ...passing }]);
    }

    // One more groceries expense in the same month passes it again: nothing more is told.
    expect(
      await record(groupId, owner.token, {
        description: 'Bread',
        date,
        amount: 5_000,
        category: 'groceries',
        ...split,
      }),
    ).toMatchObject({
      status: 201,
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const member of [owner, other]) {
      expect((await noticesOf(member.token)).filter(notice => notice.kind === 'budget')).toHaveLength(1);
    }
    expect(await budgetsOf(groupId, other.token)).toMatchObject({ body: [{ category: 'groceries', spent: 50_000 }] });
  });
});

describe('Groups → Ledger: the budgets of a group made through Groups (request 24)', () => {
  it('sets and reads the budgets of the group whose id Groups answered when it was created', async () => {
    const owner = await accountOf(uniqueEmail('owner'), 'Ana');
    const created = await http.request('POST', '/v1/groups', {
      body: { name: 'The flat', currency: 'EUR' },
      token: owner.token,
    });
    expect(created.status).toBe(201);
    const groupId = (created.body as { id: string }).id;

    expect(await setBudget(groupId, 'food', owner.token, 20_000)).toMatchObject({ status: 201 });
    expect(await budgetsOf(groupId, owner.token)).toMatchObject({
      status: 200,
      body: [{ category: 'food', amount: 20_000, spent: 0 }],
    });
  });
});

describe('Ledger → Notifications: an expense, and the budget it passes (request 17, request 24)', () => {
  it('tells each member of an expense by the id its request answered, and each member of the budget it passes', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    expect((await setBudget(groupId, 'travel', owner.token, 10_000)).status).toBe(201);
    const date = (await todayOf(owner.token)).toISOString().slice(0, 10);

    const recorded = await record(groupId, owner.token, {
      description: 'Train',
      date,
      amount: 12_000,
      category: 'travel',
      splitBetween: [owner.id, other.id],
    });
    expect(recorded.status).toBe(201);
    const expenseId = (recorded.body as { id: string }).id;

    await eventually(async () => (await noticesOf(other.token)).some(notice => notice.expenseId === expenseId));
    expect((await noticesOf(other.token)).find(notice => notice.expenseId === expenseId)).toMatchObject({
      kind: 'expense',
      groupId,
      amount: 6_000,
    });

    await eventually(async () => (await noticesOf(other.token)).some(notice => notice.kind === 'budget'));
    expect((await noticesOf(other.token)).filter(notice => notice.kind === 'budget')).toEqual([
      {
        id: expect.any(String),
        at: expect.any(String),
        kind: 'budget',
        groupId,
        category: 'travel',
        month: date.slice(0, 7),
        budget: 10_000,
        amount: 12_000,
      },
    ]);
  });
});
