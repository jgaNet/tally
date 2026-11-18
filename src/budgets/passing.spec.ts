import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';

/** The day `day` of the month `monthsAgo` months before the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(monthsAgo: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day)).toISOString().slice(0, 10);
}

interface BudgetNotice {
  id: string;
  kind: string;
  groupId: string;
  category: string;
  month: string;
  budget: number;
  amount: number;
  at: string;
}

describe('budget notices', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  /** Ada owns a group with Grace and Linus in it, and budgets 200.00 for groceries. */
  async function setup() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    const budget = await send(app, 'PUT', `/groups/${groupId}/budgets/groceries`, {
      token: ada.token,
      payload: { amount: 20000 },
    });
    expect(budget.statusCode).toBe(204);
    return { ada, grace, linus, groupId, between: [ada.id, grace.id, linus.id] };
  }

  /** An expense of `amount` in groceries, paid by Ada and split between the three; answers its id. */
  async function record(
    ada: { token: string },
    groupId: string,
    between: string[],
    amount: number,
    extra: { date?: string; category?: string } = {},
  ): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: {
        description: 'Shop',
        amount,
        date: todayInUtc(),
        splitBetween: between,
        category: 'groceries',
        ...extra,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function budgetNoticesOf(token: string): Promise<BudgetNotice[]> {
    const response = await send(app, 'GET', '/notices', { token });
    expect(response.statusCode).toBe(200);
    return response.json<BudgetNotice[]>().filter(notice => notice.kind === 'budget');
  }

  const currentMonth = () => todayInUtc().slice(0, 7);

  it('tells every member, the payer included, once the month passes the budget, with the month, the budget and what it spends', async () => {
    const { ada, grace, linus, groupId, between } = await setup();
    await record(ada, groupId, between, 25000);

    for (const member of [ada, grace, linus]) {
      expect(await budgetNoticesOf(member.token)).toEqual([
        {
          id: expect.any(String),
          kind: 'budget',
          groupId,
          category: 'groceries',
          month: currentMonth(),
          budget: 20000,
          amount: 25000,
          at: expect.any(String),
        },
      ]);
    }
  });

  it('tells nothing while the month spends exactly its budget, and tells once it spends more', async () => {
    const { ada, grace, groupId, between } = await setup();
    await record(ada, groupId, between, 15000);
    await record(ada, groupId, between, 5000);
    expect(await budgetNoticesOf(grace.token)).toEqual([]);

    await record(ada, groupId, between, 1);
    expect((await budgetNoticesOf(grace.token)).map(notice => notice.amount)).toEqual([20001]);
  });

  it('tells nothing more about a month that goes further over, or comes back under and over again', async () => {
    const { ada, grace, groupId, between } = await setup();
    const big = await record(ada, groupId, between, 25000);
    expect((await budgetNoticesOf(grace.token)).map(notice => notice.amount)).toEqual([25000]);

    await record(ada, groupId, between, 5000); // further over
    await send(app, 'DELETE', `/expenses/${big}`, { token: ada.token }); // back under: 5000 of 20000
    await record(ada, groupId, between, 30000); // over again
    await record(ada, groupId, between, 1000);

    const notices = await budgetNoticesOf(grace.token);
    expect(notices).toHaveLength(1);
    expect(notices[0].amount).toBe(25000);
  });

  it('tells again for another month, and for another category, once each', async () => {
    const { ada, grace, groupId, between } = await setup();
    await send(app, 'PUT', `/groups/${groupId}/budgets/rent`, { token: ada.token, payload: { amount: 10000 } });
    await record(ada, groupId, between, 25000, { date: dayOfMonth(1, 15) }); // last month
    await record(ada, groupId, between, 25000); // this month
    await record(ada, groupId, between, 15000, { category: 'rent' }); // rent, this month
    await record(ada, groupId, between, 1000, { category: 'rent' }); // no more about rent this month

    const notices = await budgetNoticesOf(grace.token);
    expect(notices.map(notice => [notice.category, notice.month, notice.amount]).sort()).toEqual(
      [
        ['groceries', currentMonth(), 25000],
        ['groceries', dayOfMonth(1, 15).slice(0, 7), 25000],
        ['rent', currentMonth(), 15000],
      ].sort(),
    );
  });

  it('tells when an edit takes the month past its budget, and not again for the same month', async () => {
    const { ada, grace, groupId, between } = await setup();
    const id = await record(ada, groupId, between, 10000);
    expect(await budgetNoticesOf(grace.token)).toEqual([]);

    const edit = (amount: number, version: number, category = 'groceries') =>
      send(app, 'PUT', `/expenses/${id}`, {
        token: ada.token,
        payload: { description: 'Shop', amount, date: todayInUtc(), splitBetween: between, category, version },
      });
    expect((await edit(25000, 1)).statusCode).toBe(204);
    expect((await budgetNoticesOf(grace.token)).map(notice => notice.amount)).toEqual([25000]);

    expect((await edit(26000, 2)).statusCode).toBe(204);
    expect(await budgetNoticesOf(grace.token)).toHaveLength(1);
  });

  it('tells when an edit moves an expense into a category that is over its budget', async () => {
    const { ada, grace, groupId, between } = await setup();
    await send(app, 'PUT', `/groups/${groupId}/budgets/leisure`, { token: ada.token, payload: { amount: 5000 } });
    const id = await record(ada, groupId, between, 9000, { category: 'other' });
    expect(await budgetNoticesOf(grace.token)).toEqual([]);

    const moved = await send(app, 'PUT', `/expenses/${id}`, {
      token: ada.token,
      payload: {
        description: 'Shop',
        amount: 9000,
        date: todayInUtc(),
        splitBetween: between,
        category: 'leisure',
        version: 1,
      },
    });
    expect(moved.statusCode).toBe(204);
    const notices = await budgetNoticesOf(grace.token);
    expect(notices.map(notice => [notice.category, notice.budget, notice.amount])).toEqual([['leisure', 5000, 9000]]);
  });

  it('tells nothing when a budget is set or changed, only when spending passes it', async () => {
    const { ada, grace, groupId, between } = await setup();
    await send(app, 'PUT', `/groups/${groupId}/budgets/food`, { token: ada.token, payload: { amount: 100 } });
    await record(ada, groupId, between, 25000, { category: 'food' });
    expect(await budgetNoticesOf(grace.token)).toHaveLength(1);

    await send(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { token: ada.token, payload: { amount: 1000 } });
    await send(app, 'PUT', `/groups/${groupId}/budgets/rent`, { token: ada.token, payload: { amount: 1 } });
    await record(ada, groupId, between, 500, { category: 'groceries' }); // 500 of 1000: not yet passed
    expect((await budgetNoticesOf(grace.token)).map(notice => notice.category)).toEqual(['food']);

    await record(ada, groupId, between, 600, { category: 'groceries' }); // 1100 of 1000: passed
    const notices = await budgetNoticesOf(grace.token);
    // The most recent first.
    expect(notices.map(notice => [notice.category, notice.budget, notice.amount])).toEqual([
      ['groceries', 1000, 1100],
      ['food', 100, 25000],
    ]);
  });

  it('tells a recurring expense that its job records past the budget, once', async () => {
    const { ada, grace, groupId, between } = await setup();
    const created = await send(app, 'POST', `/groups/${groupId}/recurring`, {
      token: ada.token,
      payload: {
        description: 'Weekly shop',
        amount: 25000,
        startsOn: `${todayInUtc().slice(0, 8)}01`,
        category: 'groceries',
        splitBetween: between,
      },
    });
    expect(created.statusCode).toBe(201);

    app.runJobs(new Date());
    app.runJobs(new Date());
    const notices = await budgetNoticesOf(grace.token);
    expect(notices.map(notice => [notice.category, notice.month, notice.amount])).toEqual([
      ['groceries', currentMonth(), 25000],
    ]);
  });

  it('keeps its notices when the server stops and starts again, and makes none twice for the month', async () => {
    const { ada, grace, groupId, between } = await setup();
    await record(ada, groupId, between, 25000);
    await app.stop();

    app = await createApplication({ databasePath });
    expect(await budgetNoticesOf(grace.token)).toHaveLength(1);
    await record(ada, groupId, between, 1000);
    expect(await budgetNoticesOf(grace.token)).toHaveLength(1);
  });

  it('keeps a notice after its expense is deleted, and is not told again when another expense passes the budget', async () => {
    const { ada, grace, groupId, between } = await setup();
    const id = await record(ada, groupId, between, 25000);
    await send(app, 'DELETE', `/expenses/${id}`, { token: ada.token });

    expect((await budgetNoticesOf(grace.token)).map(notice => notice.amount)).toEqual([25000]);
    await record(ada, groupId, between, 30000);
    expect(await budgetNoticesOf(grace.token)).toHaveLength(1);
  });

  it('makes no notice for an expense refused for any reason', async () => {
    const { ada, grace, groupId, between } = await setup();
    const refused = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ada.token,
      payload: { description: '  ', amount: 25000, date: todayInUtc(), splitBetween: between, category: 'groceries' },
    });
    expect(refused.statusCode).toBe(422);
    expect(await budgetNoticesOf(grace.token)).toEqual([]);
  });
});
