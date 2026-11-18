import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';

/** The `day` of the month `months` from the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(months: number, day: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, day));
  return month.toISOString().slice(0, 10);
}

interface Recurring {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  splitBetween?: string[];
  splitExactly?: { memberId: string; amount: number }[];
  splitByShares?: { memberId: string; shares: number }[];
}

describe('recurring expenses', () => {
  let app: Application;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    app = await createApplication({ databaseUrl });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function setup() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, groupId };
  }

  const rent = (startsOn: string, split: object) => ({ description: 'Rent', amount: 90000, startsOn, ...split });

  async function expensesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/expenses`, { token });
    return response.json<{ id: string; date: string; paidBy: string; amount: number; description: string }[]>();
  }

  it('sets it up and reads it as it was given, its next day being its first', async () => {
    const { ada, grace, groupId } = await setup();
    const startsOn = dayOfMonth(2, 5);
    const created = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: rent(startsOn, {
        splitByShares: [
          { memberId: ada.id, shares: 1 },
          { memberId: grace.id, shares: 2 },
        ],
      }),
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    const read = await send(app, 'GET', `/recurring/${id}`, { token: grace.token });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      id,
      groupId,
      paidBy: ada.id,
      description: 'Rent',
      amount: 90000,
      startsOn,
      next: startsOn,
      category: 'other',
      splitByShares: [
        { memberId: ada.id, shares: 1 },
        { memberId: grace.id, shares: 2 },
      ],
    });
  });

  it('refuses what an expense or a start day does not allow', async () => {
    const { ada, grace, groupId } = await setup();
    const outsider = await signedUpAccount(app, { email: 'out@example.com', name: 'Out' });
    const post = (token: string, payload: object) =>
      send(app, 'POST', `/groups/${groupId}/recurring`, { token, payload });
    const both = { splitBetween: [ada.id, grace.id] };
    const bad = [
      rent('2026-02-30', both),
      rent(dayOfMonth(0, 29), both),
      rent(dayOfMonth(0, 0), both),
      rent(
        todayInUtc()
          .replace(/^\d{4}/, y => String(Number(y) + 2))
          .slice(0, 8) + '05',
        both,
      ),
      rent(dayOfMonth(-14, 5), both),
      rent(dayOfMonth(14, 5), both),
      rent('not a day', both),
      { ...rent(dayOfMonth(1, 5), both), amount: 0 },
      { ...rent(dayOfMonth(1, 5), both), description: '  ' },
      rent(dayOfMonth(1, 5), { splitBetween: [grace.id] }),
      rent(dayOfMonth(1, 5), { splitBetween: [ada.id, ada.id] }),
      rent(dayOfMonth(1, 5), { splitBetween: [ada.id, outsider.id] }),
      rent(dayOfMonth(1, 5), {
        splitExactly: [
          { memberId: ada.id, amount: 1 },
          { memberId: grace.id, amount: 1 },
        ],
      }),
    ];
    for (const payload of bad) {
      expect((await post(ada.token, payload)).statusCode).toBe(422);
    }
    expect((await post(ada.token, rent(dayOfMonth(1, 5), {}))).statusCode).toBe(400);
    expect((await post(outsider.token, rent(dayOfMonth(1, 5), both))).statusCode).toBe(404);
    expect((await post(ada.token, rent(dayOfMonth(-11, 5), both))).statusCode).toBe(201);
    expect((await post(ada.token, rent(dayOfMonth(11, 5), both))).statusCode).toBe(201);
    expect((await expensesOf(ada.token, groupId)).length).toBe(0);
  });

  it('records the expenses of every day passed at the next run, once, and the next on its day', async () => {
    const { ada, grace, groupId } = await setup();
    const startsOn = dayOfMonth(-2, 5);
    const { id } = (
      await send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: grace.token,
        payload: rent(startsOn, { splitBetween: [ada.id, grace.id] }),
      })
    ).json<{ id: string }>();
    // Reading records nothing.
    expect((await expensesOf(ada.token, groupId)).length).toBe(0);
    expect((await send(app, 'GET', `/recurring/${id}`, { token: ada.token })).json<Recurring>().next).toBe(startsOn);

    const at = new Date('2026-11-10T08:00:00Z');
    await app.runJobs(at);
    await app.runJobs(at);
    await app.runJobs(new Date('2026-11-10T09:00:00Z'));
    const dates = (await expensesOf(ada.token, groupId)).map(expense => expense.date);
    expect(dates).toEqual([dayOfMonth(0, 5), dayOfMonth(-1, 5), startsOn].filter(date => date <= '2026-11-10'));
    const expectedCount = [startsOn, dayOfMonth(-1, 5), dayOfMonth(0, 5)].filter(date => date <= '2026-11-10').length;
    expect(dates.length).toBe(expectedCount);
    const first = (await expensesOf(ada.token, groupId))[0];
    expect(first).toMatchObject({ paidBy: grace.id, amount: 90000, description: 'Rent' });

    const read = (await send(app, 'GET', `/recurring/${id}`, { token: ada.token })).json<Recurring>();
    expect(read.next > '2026-11-10').toBe(true);
    expect(read.next.slice(8)).toBe('05');

    // The next one is recorded on its day, not before.
    const nextDay = read.next;
    await app.runJobs(new Date(`${nextDay}T00:00:00Z`));
    expect((await expensesOf(ada.token, groupId)).length).toBe(expectedCount + 1);
    expect((await expensesOf(ada.token, groupId))[0].date).toBe(nextDay);
  });

  it('records expenses like any other: balances, notices, edit and delete by the payer or the owner', async () => {
    const { ada, grace, groupId } = await setup();
    await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: rent(dayOfMonth(-1, 5), {
        splitExactly: [
          { memberId: ada.id, amount: 30000 },
          { memberId: grace.id, amount: 60000 },
        ],
      }),
    });
    await app.runJobs(new Date(`${dayOfMonth(-1, 5)}T10:00:00Z`));
    const [expense] = await expensesOf(ada.token, groupId);
    const balances = (await send(app, 'GET', `/groups/${groupId}/balances`, { token: ada.token })).json<
      { memberId: string; balance: number }[]
    >();
    expect(balances.find(balance => balance.memberId === ada.id)?.balance).toBe(60000);
    expect(balances.find(balance => balance.memberId === grace.id)?.balance).toBe(-60000);
    const notices = (await send(app, 'GET', '/notices', { token: grace.token })).json<
      { expenseId: string; amount: number }[]
    >();
    expect(notices).toMatchObject([{ expenseId: expense.id, amount: 60000 }]);
    expect((await send(app, 'DELETE', `/expenses/${expense.id}`, { token: grace.token })).statusCode).toBe(403);
    expect((await send(app, 'DELETE', `/expenses/${expense.id}`, { token: ada.token })).statusCode).toBe(204);
    // Deleting it does not bring it back.
    await app.runJobs(new Date(`${dayOfMonth(-1, 5)}T11:00:00Z`));
    expect((await expensesOf(ada.token, groupId)).length).toBe(0);
  });

  it("lists the group's, the earliest set up first, to members only", async () => {
    const { ada, grace, groupId } = await setup();
    const outsider = await signedUpAccount(app, { email: 'out@example.com', name: 'Out' });
    for (const description of ['One', 'Two', 'Three']) {
      await send(app, 'POST', `/groups/${groupId}/recurring`, {
        token: ada.token,
        payload: { ...rent(dayOfMonth(1, 5), { splitBetween: [ada.id] }), description },
      });
    }
    const list = await send(app, 'GET', `/groups/${groupId}/recurring`, { token: grace.token });
    expect(list.json<Recurring[]>().map(item => item.description)).toEqual(['One', 'Two', 'Three']);
    expect((await send(app, 'GET', `/groups/${groupId}/recurring`, { token: outsider.token })).statusCode).toBe(404);
    const { id } = list.json<Recurring[]>()[0];
    expect((await send(app, 'GET', `/recurring/${id}`, { token: outsider.token })).statusCode).toBe(404);
  });

  it('is stopped by its payer or the owner, and the expenses it recorded stay', async () => {
    const { ada, grace, groupId } = await setup();
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    const make = async (token: string) =>
      (
        await send(app, 'POST', `/groups/${groupId}/recurring`, {
          token,
          payload: rent(dayOfMonth(-1, 5), { splitBetween: [ada.id, grace.id, linus.id].filter(() => true) }),
        })
      ).json<{ id: string }>().id;
    const hers = await make(grace.token);
    expect((await send(app, 'DELETE', `/recurring/${hers}`, { token: linus.token })).statusCode).toBe(403);
    await app.runJobs(new Date(`${dayOfMonth(-1, 5)}T10:00:00Z`));
    expect((await expensesOf(ada.token, groupId)).length).toBe(1);
    expect((await send(app, 'DELETE', `/recurring/${hers}`, { token: grace.token })).statusCode).toBe(204);
    expect((await send(app, 'GET', `/recurring/${hers}`, { token: ada.token })).statusCode).toBe(404);
    await app.runJobs(new Date(`${dayOfMonth(3, 28)}T10:00:00Z`));
    expect((await expensesOf(ada.token, groupId)).length).toBe(1);
    const another = await make(grace.token);
    expect((await send(app, 'DELETE', `/recurring/${another}`, { token: ada.token })).statusCode).toBe(204);
  });

  it('ends, recording nothing, on a day when its payer or a member of its split has left', async () => {
    const { ada, grace, groupId } = await setup();
    const make = async (payer: { token: string }) =>
      (
        await send(app, 'POST', `/groups/${groupId}/recurring`, {
          token: payer.token,
          payload: rent(dayOfMonth(1, 5), { splitBetween: [ada.id, grace.id] }),
        })
      ).json<{ id: string }>().id;
    const bySplit = await make(ada);
    const byPayer = await make(grace);
    const left = await send(app, 'POST', `/groups/${groupId}/leave`, { token: grace.token });
    expect(left.statusCode).toBe(204);
    await app.runJobs(new Date(`${dayOfMonth(1, 5)}T10:00:00Z`));
    expect((await expensesOf(ada.token, groupId)).length).toBe(0);
    for (const id of [bySplit, byPayer]) {
      expect((await send(app, 'GET', `/recurring/${id}`, { token: ada.token })).statusCode).toBe(404);
    }
    expect((await send(app, 'GET', `/groups/${groupId}/recurring`, { token: ada.token })).json()).toEqual([]);
  });

  it('records each day once when two servers share the database and run together', async () => {
    const { ada, groupId } = await setup();
    await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: rent(dayOfMonth(-2, 5), { splitBetween: [ada.id] }),
    });
    const other = await createApplication({ databaseUrl });
    try {
      const at = new Date(`${dayOfMonth(0, 28)}T10:00:00Z`);
      await other.runJobs(at);
      await app.runJobs(at);
      await other.runJobs(at);
      const dates = (await expensesOf(ada.token, groupId)).map(expense => expense.date);
      expect(new Set(dates).size).toBe(dates.length);
      expect(dates.length).toBe(3);
    } finally {
      await other.stop();
    }
  });
});
