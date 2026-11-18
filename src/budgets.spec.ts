import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const eve = { email: 'eve@example.com', password: 'outsider-2026', name: 'Eve Outsider' };

const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

const today = (): string => new Date().toISOString().slice(0, 10);
const thisMonth = (): string => today().slice(0, 7);

/** The last day of the month before this one, in UTC: a day already past whatever day it is now. */
function lastDayOfLastMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

interface Notice {
  id: string;
  kind: string;
  groupId: string;
  expenseId?: string;
  category?: string;
  month?: string;
  budget?: number;
  amount: number;
  at: string;
}

describe('budgets', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let eveToken: string;
  let groupId: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada): Promise<{ id: string; token: string }> {
    const id = (await call(app, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(app, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Brings the account into the group by an invitation of the owner. */
  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  /** Records an expense of the group, paid by the token's account, split between the three members, dated today. */
  async function record(fields: Record<string, unknown> = {}, token = adaToken): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Shop', amount: 9000, date: today(), splitBetween: [adaId, graceId, linusId], ...fields },
      token,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  /** Edits an expense from the version given, whole, as the edit of request 6 takes it. */
  async function edit(id: string, version: number, fields: Record<string, unknown>, token = adaToken) {
    return call(app, 'PUT', `/expenses/${id}`, {
      body: {
        description: 'Shop',
        amount: 9000,
        date: today(),
        splitBetween: [adaId, graceId, linusId],
        version,
        ...fields,
      },
      token,
    });
  }

  async function setBudget(category: string, amount: number, token = adaToken): Promise<void> {
    const answer = await call(app, 'PUT', `/groups/${groupId}/budgets/${category}`, { body: { amount }, token });
    expect(answer.status).toBe(204);
  }

  async function expenseOf(id: string) {
    return (await call(app, 'GET', `/expenses/${id}`, { token: adaToken })).body;
  }

  /** The notices of the account, as the API answers them. */
  async function noticesOf(token: string): Promise<Notice[]> {
    const answer = await call(app, 'GET', '/notices', { token });
    expect(answer.status).toBe(200);
    return answer.body;
  }

  async function budgetNoticesOf(token: string): Promise<Notice[]> {
    return (await noticesOf(token)).filter(notice => notice.kind === 'budget');
  }

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    ({ token: eveToken } = await accountOf(eve));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  describe('categories', () => {
    it('gives an expense the category it is recorded with, and other when none is given', async () => {
      const groceries = await record({ category: 'groceries' });
      const none = await record();
      expect(await expenseOf(groceries)).toMatchObject({ category: 'groceries' });
      expect(await expenseOf(none)).toMatchObject({ category: 'other' });
    });

    it('refuses a category that is not one of the eight, with 400', async () => {
      const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: { description: 'Cars', amount: 100, date: today(), splitBetween: [adaId], category: 'cars' },
        token: adaToken,
      });
      expect(answer.status).toBe(400);
    });

    it('gives an edited expense the category it is edited with, and other when the edit leaves it out', async () => {
      const id = await record({ category: 'food' });
      expect((await edit(id, 1, { category: 'travel' })).status).toBe(204);
      expect(await expenseOf(id)).toMatchObject({ category: 'travel', version: 2 });
      expect((await edit(id, 2, {})).status).toBe(204);
      expect(await expenseOf(id)).toMatchObject({ category: 'other', version: 3 });
    });

    it('gives a recurring expense its category, read back and in the expenses it records', async () => {
      const created = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: {
          description: 'Rent',
          amount: 50000,
          startsOn: `${thisMonth()}-01`,
          category: 'rent',
          splitBetween: [adaId, graceId],
        },
        token: adaToken,
      });
      expect(created.status).toBe(201);
      expect((await call(app, 'GET', `/recurring/${created.body.id}`, { token: adaToken })).body).toMatchObject({
        category: 'rent',
      });

      await app.runJobs();
      const expenses = (await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken })).body;
      expect(expenses).toHaveLength(1);
      expect(expenses[0]).toMatchObject({ description: 'Rent', category: 'rent' });
    });

    it('gives a recurring expense set up without a category the category other', async () => {
      const created = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: { description: 'Gym', amount: 1000, startsOn: `${thisMonth()}-01`, splitBetween: [adaId] },
        token: adaToken,
      });
      expect((await call(app, 'GET', `/recurring/${created.body.id}`, { token: adaToken })).body).toMatchObject({
        category: 'other',
      });
    });
  });

  describe('setting budgets', () => {
    it('lets the owner set a budget, read by any member with what the month spends', async () => {
      await setBudget('groceries', 40000);
      expect(await call(app, 'GET', `/groups/${groupId}/budgets`, { token: linusToken })).toEqual({
        status: 200,
        body: [{ category: 'groceries', amount: 40000, spent: 0 }],
      });
    });

    it('replaces the amount of a budget set again', async () => {
      await setBudget('groceries', 40000);
      await setBudget('groceries', 30000);
      expect((await call(app, 'GET', `/groups/${groupId}/budgets`, { token: adaToken })).body).toEqual([
        { category: 'groceries', amount: 30000, spent: 0 },
      ]);
    });

    it('lists the budgets in the order of the categories', async () => {
      await setBudget('other', 1000);
      await setBudget('food', 2000);
      await setBudget('groceries', 3000);
      const body = (await call(app, 'GET', `/groups/${groupId}/budgets`, { token: graceToken })).body;
      expect(body.map((budget: { category: string }) => budget.category)).toEqual(['groceries', 'food', 'other']);
    });

    it('refuses a member who is not the owner with 403, and keeps the budget as it was', async () => {
      await setBudget('groceries', 40000);
      const answer = await call(app, 'PUT', `/groups/${groupId}/budgets/groceries`, {
        body: { amount: 1 },
        token: graceToken,
      });
      expect(answer).toMatchObject({ status: 403, body: { type: 'NotAllowed' } });
      expect((await call(app, 'GET', `/groups/${groupId}/budgets`, { token: adaToken })).body).toEqual([
        { category: 'groceries', amount: 40000, spent: 0 },
      ]);
    });

    it('answers an account outside the group as if the group did not exist', async () => {
      const answer = await call(app, 'PUT', `/groups/${groupId}/budgets/groceries`, {
        body: { amount: 1000 },
        token: eveToken,
      });
      expect(answer.status).toBe(404);
      expect((await call(app, 'GET', `/groups/${groupId}/budgets`, { token: eveToken })).status).toBe(404);
    });

    it('takes amounts from 1 to 100 000 000, and refuses others with 422', async () => {
      expect(
        (await call(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { body: { amount: 0 }, token: adaToken })).body,
      ).toMatchObject({ type: 'InvalidAmount' });
      expect(
        (
          await call(app, 'PUT', `/groups/${groupId}/budgets/groceries`, {
            body: { amount: 100_000_001 },
            token: adaToken,
          })
        ).status,
      ).toBe(422);
      expect(
        (await call(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { body: { amount: 1 }, token: adaToken }))
          .status,
      ).toBe(204);
      expect(
        (
          await call(app, 'PUT', `/groups/${groupId}/budgets/food`, {
            body: { amount: 100_000_000 },
            token: adaToken,
          })
        ).status,
      ).toBe(204);
    });

    it('refuses an amount that is not a whole number with 400', async () => {
      const answer = await call(app, 'PUT', `/groups/${groupId}/budgets/groceries`, {
        body: { amount: 1.5 },
        token: adaToken,
      });
      expect(answer.status).toBe(400);
    });

    it('refuses a category that is not one of the eight with 422', async () => {
      const answer = await call(app, 'PUT', `/groups/${groupId}/budgets/cars`, {
        body: { amount: 1000 },
        token: adaToken,
      });
      expect(answer).toMatchObject({ status: 422, body: { type: 'InvalidCategory' } });
    });

    it('removes a budget for the owner, which is then not listed, and refuses a member the removal', async () => {
      await setBudget('groceries', 40000);
      expect((await call(app, 'DELETE', `/groups/${groupId}/budgets/groceries`, { token: graceToken })).status).toBe(
        403,
      );
      expect((await call(app, 'DELETE', `/groups/${groupId}/budgets/groceries`, { token: adaToken })).status).toBe(204);
      expect((await call(app, 'GET', `/groups/${groupId}/budgets`, { token: adaToken })).body).toEqual([]);
    });

    it('answers 404 to the removal of a budget that is not set', async () => {
      const answer = await call(app, 'DELETE', `/groups/${groupId}/budgets/rent`, { token: adaToken });
      expect(answer).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    });

    it('refuses a request without a token with 401', async () => {
      expect((await call(app, 'GET', `/groups/${groupId}/budgets`)).status).toBe(401);
      expect((await call(app, 'PUT', `/groups/${groupId}/budgets/groceries`, { body: { amount: 1 } })).status).toBe(
        401,
      );
    });
  });

  describe('what a month spends', () => {
    it('counts the expenses of the category in the current month, deleted ones left out', async () => {
      await setBudget('groceries', 100000);
      await record({ category: 'groceries', amount: 9000 });
      await record({ category: 'groceries', amount: 6000 }, graceToken);
      await record({ category: 'rent', amount: 50000 });
      await record({ category: 'groceries', amount: 7000, date: lastDayOfLastMonth() });
      const deleted = await record({ category: 'groceries', amount: 4000 });
      expect((await call(app, 'DELETE', `/expenses/${deleted}`, { token: adaToken })).status).toBe(204);

      expect((await call(app, 'GET', `/groups/${groupId}/budgets`, { token: linusToken })).body).toEqual([
        { category: 'groceries', amount: 100000, spent: 15000 },
      ]);
    });
  });

  describe('passing a budget', () => {
    it('tells every member, the payer too, once when a month passes a budget', async () => {
      await setBudget('groceries', 40000);
      await record({ category: 'groceries', amount: 25000 });
      expect(await budgetNoticesOf(linusToken)).toEqual([]);

      const passing = await record({ category: 'groceries', amount: 20000 });
      const expected = {
        id: expect.any(String),
        kind: 'budget',
        groupId,
        category: 'groceries',
        month: thisMonth(),
        budget: 40000,
        amount: 45000,
        at: expect.stringMatching(AT_PATTERN),
      };
      for (const token of [adaToken, graceToken, linusToken]) {
        expect(await budgetNoticesOf(token)).toEqual([expected]);
      }
      expect(await expenseOf(passing)).toMatchObject({ category: 'groceries', amount: 20000 });
    });

    it('makes no other notice for the month, however far it goes over, nor when it comes back under and over again', async () => {
      await setBudget('groceries', 40000);
      await record({ category: 'groceries', amount: 25000 });
      const passing = await record({ category: 'groceries', amount: 20000 });
      await record({ category: 'groceries', amount: 1000 });
      expect((await edit(passing, 1, { category: 'groceries', amount: 1000 })).status).toBe(204);
      await record({ category: 'groceries', amount: 30000 });

      for (const token of [adaToken, graceToken, linusToken]) {
        expect(await budgetNoticesOf(token)).toHaveLength(1);
      }
    });

    it('makes no notice while a month is within its budget, nor when it is exactly at the budget', async () => {
      await setBudget('groceries', 40000);
      await record({ category: 'groceries', amount: 40000 });
      expect(await budgetNoticesOf(adaToken)).toEqual([]);
      expect(await budgetNoticesOf(linusToken)).toEqual([]);
    });

    it('makes no notice for a category without a budget, and none when a budget is only set', async () => {
      await record({ category: 'groceries', amount: 50000 });
      await record({ category: 'rent', amount: 90000 });
      expect(await budgetNoticesOf(adaToken)).toEqual([]);

      await setBudget('groceries', 40000);
      expect(await budgetNoticesOf(adaToken)).toEqual([]);

      await record({ category: 'groceries', amount: 1000 });
      expect(await budgetNoticesOf(adaToken)).toEqual([
        expect.objectContaining({ category: 'groceries', amount: 51000 }),
      ]);
      expect(await budgetNoticesOf(adaToken)).toHaveLength(1);
    });

    it('notes a month by the date of the expense, which may be a month before', async () => {
      await setBudget('groceries', 40000);
      const day = lastDayOfLastMonth();
      await record({ category: 'groceries', amount: 50000, date: day });
      expect(await budgetNoticesOf(graceToken)).toEqual([
        expect.objectContaining({ category: 'groceries', month: day.slice(0, 7), budget: 40000, amount: 50000 }),
      ]);
    });

    it('notes a passing made by an edit that takes an expense over its budget', async () => {
      await setBudget('groceries', 40000);
      await record({ category: 'groceries', amount: 30000 });
      const id = await record({ category: 'groceries', amount: 5000 });
      expect(await budgetNoticesOf(adaToken)).toEqual([]);

      expect((await edit(id, 1, { category: 'groceries', amount: 15000 })).status).toBe(204);
      expect(await budgetNoticesOf(linusToken)).toEqual([
        expect.objectContaining({ category: 'groceries', month: thisMonth(), budget: 40000, amount: 45000 }),
      ]);
    });

    it('notes a passing made by a recurring expense the background job records', async () => {
      await setBudget('groceries', 40000);
      const created = await call(app, 'POST', `/groups/${groupId}/recurring`, {
        body: {
          description: 'Groceries',
          amount: 50000,
          startsOn: `${thisMonth()}-01`,
          category: 'groceries',
          splitBetween: [adaId, graceId, linusId],
        },
        token: adaToken,
      });
      expect(created.status).toBe(201);
      await app.runJobs();

      for (const token of [adaToken, graceToken, linusToken]) {
        expect(await budgetNoticesOf(token)).toEqual([
          expect.objectContaining({ category: 'groceries', month: thisMonth(), budget: 40000, amount: 50000 }),
        ]);
      }
    });

    it('tells no one who has left the group', async () => {
      await setBudget('groceries', 40000);
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: linusToken })).status).toBe(204);
      await record({ category: 'groceries', amount: 50000, splitBetween: [adaId, graceId] }, adaToken);
      expect(await budgetNoticesOf(adaToken)).toHaveLength(1);
      expect(await budgetNoticesOf(graceToken)).toHaveLength(1);
      expect(await budgetNoticesOf(linusToken)).toEqual([]);
    });

    it('keeps exactly one notice per member when the server is stopped and started again', async () => {
      await setBudget('groceries', 40000);
      await record({ category: 'groceries', amount: 50000 });
      await app.stop();
      app = await startApplication(database.url);

      await record({ category: 'groceries', amount: 10000 });
      for (const token of [adaToken, graceToken, linusToken]) {
        expect(await budgetNoticesOf(token)).toHaveLength(1);
      }
    });

    it('lists a budget notice with its category, month and budget, and no expense', async () => {
      await setBudget('groceries', 40000);
      await record({ category: 'groceries', amount: 50000 });
      const [notice] = await budgetNoticesOf(linusToken);
      expect(notice).not.toHaveProperty('expenseId');
      expect(Object.keys(notice).sort()).toEqual(
        ['amount', 'at', 'budget', 'category', 'groupId', 'id', 'kind', 'month'].sort(),
      );
    });
  });
});
