import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';

/** The day `day` of the month `monthsAgo` months before the current one (UTC), as `YYYY-MM-DD`. */
function dayOfMonth(monthsAgo: number, day: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day)).toISOString().slice(0, 10);
}

describe('budgets', () => {
  let app: Application;

  beforeEach(async () => {
    app = await createApplication({ databaseUrl: await temporaryDatabaseUrl() });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function setup() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const outsider = await signedUpAccount(app, { email: 'out@example.com', name: 'Out' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, outsider, groupId };
  }

  const setBudget = (token: string, groupId: string, category: string, amount: number) =>
    send(app, 'PUT', `/groups/${groupId}/budgets/${category}`, { token, payload: { amount } });

  async function budgetsOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/budgets`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ category: string; amount: number; spent: number }[]>();
  }

  it('sets the monthly budget of a category, which the owner sets again to replace', async () => {
    const { ada, grace, groupId } = await setup();
    expect((await setBudget(ada.token, groupId, 'groceries', 40000)).statusCode).toBe(204);
    expect(await budgetsOf(grace.token, groupId)).toEqual([{ category: 'groceries', amount: 40000, spent: 0 }]);

    expect((await setBudget(ada.token, groupId, 'groceries', 30000)).statusCode).toBe(204);
    expect(await budgetsOf(grace.token, groupId)).toEqual([{ category: 'groceries', amount: 30000, spent: 0 }]);
  });

  it('lists the budgets in the order of the categories, each category with one only', async () => {
    const { ada, grace, groupId } = await setup();
    await setBudget(ada.token, groupId, 'other', 1000);
    await setBudget(ada.token, groupId, 'rent', 90000);
    await setBudget(ada.token, groupId, 'groceries', 40000);

    const listed = await budgetsOf(grace.token, groupId);
    expect(listed.map(budget => budget.category)).toEqual(['groceries', 'rent', 'other']);
    expect(listed).toEqual([
      { category: 'groceries', amount: 40000, spent: 0 },
      { category: 'rent', amount: 90000, spent: 0 },
      { category: 'other', amount: 1000, spent: 0 },
    ]);
  });

  it('removes the budget of a category, which the owner may do once', async () => {
    const { ada, groupId } = await setup();
    await setBudget(ada.token, groupId, 'travel', 5000);

    const removed = await send(app, 'DELETE', `/groups/${groupId}/budgets/travel`, { token: ada.token });
    expect(removed.statusCode).toBe(204);
    expect(await budgetsOf(ada.token, groupId)).toEqual([]);

    const again = await send(app, 'DELETE', `/groups/${groupId}/budgets/travel`, { token: ada.token });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ type: 'NotFound', message: expect.any(String) });
  });

  it('refuses any member but the owner to set or remove a budget, and answers the others as no group', async () => {
    const { ada, grace, outsider, groupId } = await setup();
    await setBudget(ada.token, groupId, 'food', 20000);

    const set = await setBudget(grace.token, groupId, 'food', 1);
    expect(set.statusCode).toBe(403);
    expect(set.json()).toEqual({ type: 'NotPermitted', message: expect.any(String) });
    const removed = await send(app, 'DELETE', `/groups/${groupId}/budgets/food`, { token: grace.token });
    expect(removed.statusCode).toBe(403);
    expect(removed.json()).toEqual({ type: 'NotPermitted', message: expect.any(String) });
    expect(await budgetsOf(ada.token, groupId)).toEqual([{ category: 'food', amount: 20000, spent: 0 }]);

    const asOutsider = await setBudget(outsider.token, groupId, 'food', 1);
    expect(asOutsider.statusCode).toBe(404);
    const readAsOutsider = await send(app, 'GET', `/groups/${groupId}/budgets`, { token: outsider.token });
    expect(readAsOutsider.statusCode).toBe(404);
  });

  it('refuses a category that is none of the categories, and an amount that is not from 1 to 100 000 000', async () => {
    const { ada, groupId } = await setup();
    const category = await setBudget(ada.token, groupId, 'snacks', 1000);
    expect(category.statusCode).toBe(422);
    expect(category.json()).toEqual({ type: 'InvalidCategory', message: expect.any(String) });

    for (const amount of [0, -5, 1.5, 100_000_001]) {
      const response = await setBudget(ada.token, groupId, 'groceries', amount);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ type: 'InvalidBudget', message: expect.any(String) });
    }
    expect(await budgetsOf(ada.token, groupId)).toEqual([]);

    expect((await setBudget(ada.token, groupId, 'groceries', 1)).statusCode).toBe(204);
    expect((await setBudget(ada.token, groupId, 'rent', 100_000_000)).statusCode).toBe(204);
    expect((await budgetsOf(ada.token, groupId)).map(budget => budget.amount)).toEqual([1, 100_000_000]);
  });

  it('answers what the current month spends in each category: its expenses of that category in that month, deleted ones left out', async () => {
    const { ada, grace, groupId } = await setup();
    await setBudget(ada.token, groupId, 'groceries', 40000);
    await setBudget(ada.token, groupId, 'rent', 90000);
    const expense = (payload: object) =>
      send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: ada.token,
        payload: {
          description: 'Shop',
          amount: 1000,
          date: todayInUtc(),
          splitBetween: [ada.id, grace.id],
          ...payload,
        },
      });

    await expense({ amount: 1000, category: 'groceries' });
    await expense({ amount: 2500, category: 'groceries', date: dayOfMonth(1, 15) }); // last month: not counted
    const deleted = await expense({ amount: 700, category: 'groceries' });
    await expense({ amount: 300, category: 'groceries' });
    await expense({ amount: 9000, category: 'rent' });
    await send(app, 'DELETE', `/expenses/${deleted.json<{ id: string }>().id}`, { token: ada.token });

    expect(await budgetsOf(grace.token, groupId)).toEqual([
      { category: 'groceries', amount: 40000, spent: 1300 },
      { category: 'rent', amount: 90000, spent: 9000 },
    ]);
  });

  it('reads the budgets of a group to its members only', async () => {
    const { ada, outsider, groupId } = await setup();
    await setBudget(ada.token, groupId, 'leisure', 2000);

    const read = await send(app, 'GET', `/groups/${groupId}/budgets`, { token: outsider.token });
    expect(read.statusCode).toBe(404);
    expect(await budgetsOf(ada.token, groupId)).toEqual([{ category: 'leisure', amount: 2000, spent: 0 }]);
  });
});
