import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Recurring expenses, over HTTP (request 23): setting one up, reading it and the group's, the refusals, the background job recording the
 * days that came, and stopping it. The job runs every 0.1 second in this suite; its answers are polled, never waited for by a fixed sleep.
 * Every answer is held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-recurring-')), 'tally.sqlite');
  process.env.JOBS_INTERVAL_SECONDS = '0.1';
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  const now = await todayOfServer();
  FUTURE_START = dayOf(now.getUTCFullYear(), now.getUTCMonth() + 1, 5);
  FUTURE_NEXT_DAY = dayOf(now.getUTCFullYear(), now.getUTCMonth() + 1, 6);
});
afterAll(() => app.stop());

let accountCount = 0;
/** A signed-in person, with a fresh email, and their token. */
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

/** A group owned by `owner`, which each of `others` has joined through an invitation. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const { id } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
  ).body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

const setUp = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/recurring`, { body, token });
const readOne = (id: string, token?: string) => http.request('GET', `${api}/recurring/${id}`, { token });
const stop = (id: string, token?: string) => http.request('DELETE', `${api}/recurring/${id}`, { token });
const groupExpenses = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/expenses`, { token });

/** A day of the calendar, written YYYY-MM-DD, whatever month `month` is (a month before or after this one, negatives too). */
const dayOf = (year: number, month: number, day: number): string =>
  new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);

/** A start a month from today, on the 5th and the 6th: within the 365 days a start may be from today, whatever day the suite runs on. */
let FUTURE_START = '';
let FUTURE_NEXT_DAY = '';

/** Today, as the server says it: the `Date` header every answer carries, so that a test reads no clock of its own (ARCH-E2E). */
const todayOfServer = async (): Promise<Date> =>
  new Date(String((await http.request('GET', `${api}/accounts/me`)).headers.get('date')));

/** Polls `read` until `ready` says its answer is the one awaited, or fails after a few seconds. */
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 100 && !ready(value); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

describe('setting up a recurring expense', () => {
  it('answers the new recurring expense, the caller its payer, and reads it back as set up', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const answer = await setUp(
      groupId,
      { description: 'Rent', amount: 90000, startsOn: FUTURE_START, splitBetween: [ada.id, grace.id] },
      ada.token,
    );
    expect(answer.status).toBe(201);
    const { id } = answer.body as { id: string };

    const read = await readOne(id, grace.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      paidBy: ada.id,
      description: 'Rent',
      amount: 90000,
      startsOn: FUTURE_START,
      next: FUTURE_START,
      category: 'other',
      splitBetween: [ada.id, grace.id],
    });
  });

  it('keeps the split as it was given, by exact amounts and by shares', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const exact = await setUp(
      groupId,
      {
        description: 'Gym',
        amount: 3000,
        startsOn: FUTURE_START,
        splitExactly: [
          { memberId: ada.id, amount: 1000 },
          { memberId: grace.id, amount: 2000 },
        ],
      },
      ada.token,
    );
    const shares = await setUp(
      groupId,
      {
        description: 'Internet',
        amount: 3000,
        startsOn: FUTURE_START,
        splitByShares: [
          { memberId: ada.id, shares: 1 },
          { memberId: grace.id, shares: 2 },
        ],
      },
      ada.token,
    );
    expect(
      ((await readOne((exact.body as { id: string }).id, ada.token)).body as { splitExactly: unknown }).splitExactly,
    ).toEqual([
      { memberId: ada.id, amount: 1000 },
      { memberId: grace.id, amount: 2000 },
    ]);
    expect(
      ((await readOne((shares.body as { id: string }).id, ada.token)).body as { splitByShares: unknown }).splitByShares,
    ).toEqual([
      { memberId: ada.id, shares: 1 },
      { memberId: grace.id, shares: 2 },
    ]);
  });

  it('refuses a start that is not a day of 1 to 28, or more than 365 days from today', async () => {
    const ada = await signedInPerson('Ada');
    const groupId = await groupWith(ada, []);
    const body = (startsOn: string) => ({ description: 'Rent', amount: 100, startsOn, splitBetween: [ada.id] });

    expect((await setUp(groupId, body('2999-01-29'), ada.token)).status).toBe(400);
    expect((await setUp(groupId, body('2999-02-30'), ada.token)).status).toBe(400);
    expect((await setUp(groupId, body('1999-01-05'), ada.token)).status).toBe(400);
    expect((await setUp(groupId, body(FUTURE_START), ada.token)).status).toBe(201);
  });

  it('refuses a body of another shape with 400, and a non-member the answer for a group that does not exist', async () => {
    const ada = await signedInPerson('Ada');
    const stranger = await signedInPerson('Stranger');
    const groupId = await groupWith(ada, []);

    expect((await setUp(groupId, { description: 'Rent', amount: 100, splitBetween: [ada.id] }, ada.token)).status).toBe(
      400,
    );
    expect(
      (
        await setUp(
          groupId,
          { description: 'Rent', amount: 100, startsOn: FUTURE_START, splitBetween: [ada.id] },
          stranger.token,
        )
      ).status,
    ).toBe(404);
  });
});

describe('reading and stopping a recurring expense', () => {
  it('lists the group’s recurring expenses, the earliest set up first, and refuses a non-member', async () => {
    const ada = await signedInPerson('Ada');
    const stranger = await signedInPerson('Stranger');
    const groupId = await groupWith(ada, []);
    const first = (
      await setUp(
        groupId,
        { description: 'Rent', amount: 100, startsOn: FUTURE_START, splitBetween: [ada.id] },
        ada.token,
      )
    ).body as { id: string };
    const second = (
      await setUp(
        groupId,
        { description: 'Gas', amount: 200, startsOn: FUTURE_NEXT_DAY, splitBetween: [ada.id] },
        ada.token,
      )
    ).body as { id: string };

    const listed = await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: ada.token });
    expect(listed.status).toBe(200);
    expect((listed.body as { id: string }[]).map(recurring => recurring.id)).toEqual([first.id, second.id]);
    expect((await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: stranger.token })).status).toBe(
      404,
    );
  });

  it('stops it by its payer, and refuses a member who is neither the payer nor the owner', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const { id } = (
      await setUp(
        groupId,
        { description: 'Rent', amount: 100, startsOn: FUTURE_START, splitBetween: [ada.id, grace.id] },
        ada.token,
      )
    ).body as { id: string };

    expect((await stop(id, grace.token)).status).toBe(403);
    expect((await stop(id, ada.token)).status).toBe(204);
    expect((await readOne(id, ada.token)).status).toBe(404);
  });
});

describe('the background job', () => {
  it('records each day that came, once, and the expenses it records are counted like any other', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const now = await todayOfServer();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const today = now.toISOString().slice(0, 10);
    // Set up two months back, on the 5th: the expenses of that day and the month after it are due, and the one after only if it has come.
    const startsOn = dayOf(year, month - 2, 5);
    const due = [0, 1, 2].map(offset => dayOf(year, month - 2 + offset, 5)).filter(day => day <= today);

    const { id } = (
      await setUp(groupId, { description: 'Rent', amount: 1000, startsOn, splitBetween: [ada.id, grace.id] }, ada.token)
    ).body as { id: string };

    const recorded = await until(
      () => groupExpenses(groupId, ada.token),
      answer => (answer.body as unknown[]).length >= due.length,
    );
    const expenses = recorded.body as { date: string; paidBy: string; description: string; amount: number }[];
    expect(expenses.map(expense => expense.date).sort()).toEqual(due);
    expect(
      expenses.every(expense => expense.paidBy === ada.id && expense.description === 'Rent' && expense.amount === 1000),
    ).toBe(true);

    // Later runs record nothing more: the days that came are recorded once.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(((await groupExpenses(groupId, ada.token)).body as unknown[]).length).toBe(due.length);
    expect(((await readOne(id, ada.token)).body as { next: string }).next > today).toBe(true);

    // Stopped, it records nothing further; the expenses it recorded stay.
    expect((await stop(id, ada.token)).status).toBe(204);
    expect(((await groupExpenses(groupId, ada.token)).body as unknown[]).length).toBe(due.length);
  });
});

describe('a recurring expense whose member has left', () => {
  it('ends when a member of its split leaves the group: it is gone, and records no expense after the leave', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const now = await todayOfServer();
    // Its first day is last month's: due at once, if the split were still whole.
    const startsOn = dayOf(now.getUTCFullYear(), now.getUTCMonth() - 1, 5);
    const { id } = (
      await setUp(groupId, { description: 'Rent', amount: 100, startsOn, splitBetween: [ada.id, grace.id] }, ada.token)
    ).body as { id: string };

    // The background job records the days that came while the split was whole, at its own pace: wait for them, so that the leave is
    // what decides every day after them. The days due are the 5th of last month, and of this month once it has come.
    const today = now.toISOString().slice(0, 10);
    const dueCount = now.getUTCDate() >= 5 ? 2 : 1;
    await until(
      () => readOne(id, ada.token),
      answer => (answer.body as { next: string }).next > today,
    );
    await until(
      () => groupExpenses(groupId, ada.token),
      answer => (answer.body as unknown[]).length >= dueCount,
    );

    expect((await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token })).status).toBe(204);

    const gone = await until(
      () => readOne(id, ada.token),
      answer => answer.status === 404,
    );
    expect(gone.status).toBe(404);
    // Nothing comes due after the leave: no expense is recorded for it, now or at any later run of the job.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(((await groupExpenses(groupId, ada.token)).body as unknown[]).length).toBe(dueCount);
  });
});
