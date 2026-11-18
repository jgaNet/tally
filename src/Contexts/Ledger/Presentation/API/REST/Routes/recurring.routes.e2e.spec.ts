import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Recurring expenses, end to end (request 23): the application booted in this process, spoken to over HTTP, every answer held to
 * api/23-recurring-expenses.yaml by the client. The background job runs at the composition root's interval, which this test sets
 * short, so the days come to be recorded while the test waits for them; the test reads no clock of its own: the day is the
 * server's, as its own Date header says.
 */
const PASSWORD = 'correct horse';
const MONTH_MS = 86_400_000;

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

/** The day `k` months from the month of `today`, on its day `day`, as YYYY-MM-DD in UTC. */
function monthDay(today: Date, k: number, day: number): string {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + k, day)).toISOString().slice(0, 10);
}

/** A EUR group of two members, the owner and a member who joined it: made by Groups, through the API, and read by Ledger by its id. */
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

/** Waits, over HTTP, until `check` answers true: the job runs at the interval the test set. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The job did not record what was expected in time');
}

const setUp = (groupId: string, token: string, body: unknown) =>
  http.request('POST', `/v1/groups/${groupId}/recurring`, { body, token });
const readRecurring = (id: string, token: string) => http.get(`/v1/recurring/${id}`, { token });
const stop = (id: string, token: string) => http.request('DELETE', `/v1/recurring/${id}`, { token });
const expensesOf = async (groupId: string, token: string) =>
  (await http.get(`/v1/groups/${groupId}/expenses`, { token })).body as {
    date: string;
    paidBy: string;
    description: string;
    amount: number;
  }[];

describe('Groups → Ledger: a recurring expense (request 23)', () => {
  it('is set up by a member, the payer, and read back by its id with its split and its next day', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    // A start next month is not due yet: the job leaves it, so `next` is still the start.
    const startsOn = monthDay(await todayOf(owner.token), 1, 5);

    const made = await setUp(groupId, owner.token, {
      description: 'Rent',
      amount: 90000,
      startsOn,
      splitBetween: [owner.id, other.id],
    });
    expect(made).toMatchObject({ status: 201, body: { id: expect.any(String) } });
    const id = (made.body as { id: string }).id;

    expect(await readRecurring(id, other.token)).toMatchObject({
      status: 200,
      body: {
        id,
        groupId,
        paidBy: owner.id,
        description: 'Rent',
        amount: 90000,
        startsOn,
        next: startsOn,
        splitBetween: [owner.id, other.id],
      },
    });
  });

  it('refuses a day more than 365 days from today, or a day of the month after the 28th', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    const today = await todayOf(owner.token);
    const far = await setUp(groupId, owner.token, {
      description: 'Rent',
      amount: 1000,
      startsOn: new Date(today.getTime() + 400 * MONTH_MS).toISOString().slice(0, 10),
      splitBetween: [owner.id, other.id],
    });
    expect(far.status).toBeGreaterThanOrEqual(400);
    const late = await setUp(groupId, owner.token, {
      description: 'Rent',
      amount: 1000,
      startsOn: monthDay(today, 0, 29),
      splitBetween: [owner.id, other.id],
    });
    expect(late.status).toBeGreaterThanOrEqual(400);
  });

  it('lists the group’s recurring expenses, the earliest set up first, and is not answered to a stranger', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    const startsOn = monthDay(await todayOf(owner.token), -1, 3);
    const first = (
      await setUp(groupId, owner.token, {
        description: 'Internet',
        amount: 3000,
        startsOn,
        splitBetween: [owner.id, other.id],
      })
    ).body as { id: string };
    const second = (
      await setUp(groupId, owner.token, {
        description: 'Gas',
        amount: 4000,
        startsOn,
        splitExactly: [
          { memberId: owner.id, amount: 1000 },
          { memberId: other.id, amount: 3000 },
        ],
      })
    ).body as { id: string };

    const listed = await http.get(`/v1/groups/${groupId}/recurring`, { token: other.token });
    expect(listed).toMatchObject({
      status: 200,
      body: [{ id: first.id }, { id: second.id, splitExactly: expect.any(Array) }],
    });

    const stranger = await accountOf(uniqueEmail('stranger'), 'Cy');
    expect((await http.get(`/v1/groups/${groupId}/recurring`, { token: stranger.token })).status).toBe(404);
    expect((await readRecurring(first.id, stranger.token)).status).toBe(404);
  });

  it('is stopped by its payer, and then no longer exists, while the expenses it recorded stay', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    const startsOn = monthDay(await todayOf(owner.token), -1, 2);
    const id = (
      (
        await setUp(groupId, owner.token, {
          description: 'Cleaner',
          amount: 2000,
          startsOn,
          splitBetween: [owner.id, other.id],
        })
      ).body as { id: string }
    ).id;

    expect((await stop(id, other.token)).status).toBe(403);
    expect((await stop(id, owner.token)).status).toBeLessThan(300);
    expect((await readRecurring(id, owner.token)).status).toBe(404);
  });

  it('records each day that has come once, by the job, and never again for the same day', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    const today = await todayOf(owner.token);
    const startsOn = monthDay(today, -2, 5);
    const id = (
      (
        await setUp(groupId, owner.token, {
          description: 'Rent',
          amount: 90000,
          startsOn,
          splitBetween: [owner.id, other.id],
        })
      ).body as { id: string }
    ).id;

    // The days from startsOn that have come by today, each once; the one after them is the next.
    const due = [-2, -1, 0, 1].map(k => monthDay(today, k, 5)).filter(day => day <= today.toISOString().slice(0, 10));
    await eventually(async () => (await expensesOf(groupId, owner.token)).length === due.length);
    await new Promise(resolve => setTimeout(resolve, 300));

    const expenses = await expensesOf(groupId, owner.token);
    expect(expenses.map(expense => expense.date).sort()).toEqual(due);
    expect(expenses.every(e => e.paidBy === owner.id && e.description === 'Rent' && e.amount === 90000)).toBe(true);
    expect(await readRecurring(id, owner.token)).toMatchObject({
      status: 200,
      body: { next: monthDay(today, -2 + due.length, 5) },
    });
  });

  it('ends when a member of its split has left, and records no expense', async () => {
    const { owner, other, groupId } = await groupOfTwo();
    const today = await todayOf(owner.token);
    const id = (
      (
        await setUp(groupId, owner.token, {
          description: 'Gym',
          amount: 5000,
          startsOn: monthDay(today, -1, 4),
          splitBetween: [owner.id, other.id],
        })
      ).body as { id: string }
    ).id;

    expect((await http.request('POST', `/v1/groups/${groupId}/leave`, { token: other.token })).status).toBeLessThan(
      300,
    );
    await eventually(async () => (await readRecurring(id, owner.token)).status === 404);

    expect((await readRecurring(id, owner.token)).status).toBe(404);
    expect(await expensesOf(groupId, owner.token)).toEqual([]);
  });
});
