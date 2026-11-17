import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';
import { todayInUtc } from './validation';

describe('unequal splits', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** Ada owns a group with Grace and Linus in it, in that order; answers their ids and tokens. */
  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  /** An expense body; the split is one of the three keys. */
  const body = (split: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    description: 'Cottage',
    amount: 1000,
    date: todayInUtc(),
    ...split,
    ...overrides,
  });

  /** An edit body: the expense as an edit gives it, from `version`, with one split. */
  const editBody = (version: number, split: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    ...body(split, overrides),
    version,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
  }

  async function recorded(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await record(token, groupId, payload);
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function putEdit(token: string, expenseId: string, payload: Record<string, unknown>) {
    return send(app, 'PUT', `/expenses/${expenseId}`, { token, payload });
  }

  async function readExpense(token: string, expenseId: string) {
    const response = await send(app, 'GET', `/expenses/${expenseId}`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{
      splitKind: string;
      version: number;
      amount: number;
      shares: { memberId: string; amount: number }[];
    }>();
  }

  async function balancesOf(token: string, groupId: string) {
    const response = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    expect(response.statusCode).toBe(200);
    return response.json<{ memberId: string; balance: number }[]>();
  }

  describe('the shape of the split', () => {
    it('is refused with 400 when the body has none of the three splits', async () => {
      const { ada, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, body({}));
      expect(response.statusCode).toBe(400);
      expect(response.json().type).toBe('InvalidBody');
    });

    it('is refused with 400 when the body has more than one of the three splits', async () => {
      const { ada, groupId } = await threeMembers();
      const twoSplits = [
        { splitBetween: [ada.id], splitExactly: [{ memberId: ada.id, amount: 1000 }] },
        { splitExactly: [{ memberId: ada.id, amount: 1000 }], splitByShares: [{ memberId: ada.id, shares: 1 }] },
        {
          splitBetween: [ada.id],
          splitExactly: [{ memberId: ada.id, amount: 1000 }],
          splitByShares: [{ memberId: ada.id, shares: 1 }],
        },
      ];
      for (const split of twoSplits) {
        const response = await record(ada.token, groupId, body(split));
        expect(response.statusCode).toBe(400);
        expect(response.json().type).toBe('InvalidBody');
      }
    });

    it('is refused with 400 on an edit too, with none of the three or with more than one', async () => {
      const { ada, groupId } = await threeMembers();
      const id = await recorded(ada.token, groupId, body({ splitBetween: [ada.id] }));
      const none = await putEdit(ada.token, id, editBody(1, {}));
      const more = await putEdit(
        ada.token,
        id,
        editBody(1, { splitBetween: [ada.id], splitByShares: [{ memberId: ada.id, shares: 1 }] }),
      );
      expect(none.statusCode).toBe(400);
      expect(more.statusCode).toBe(400);
      expect((await readExpense(ada.token, id)).version).toBe(1);
    });

    it('refuses a share with a missing member, or a fractional number of shares, with 400', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const noMember = await record(ada.token, groupId, body({ splitByShares: [{ shares: 1 }] }));
      const fractional = await record(
        ada.token,
        groupId,
        body({
          splitByShares: [
            { memberId: ada.id, shares: 1.5 },
            { memberId: grace.id, shares: 1 },
          ],
        }),
      );
      expect(noMember.statusCode).toBe(400);
      expect(fractional.statusCode).toBe(400);
    });
  });

  describe('by exact amounts', () => {
    it('records the amounts as they are given, in the order given, and reads them as exact', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = await recorded(
        ada.token,
        groupId,
        body({
          splitExactly: [
            { memberId: linus.id, amount: 200 },
            { memberId: ada.id, amount: 500 },
            { memberId: grace.id, amount: 300 },
          ],
        }),
      );
      const expense = await readExpense(grace.token, id);
      expect(expense.splitKind).toBe('exact');
      expect(expense.shares).toEqual([
        { memberId: linus.id, amount: 200 },
        { memberId: ada.id, amount: 500 },
        { memberId: grace.id, amount: 300 },
      ]);
    });

    it('accepts an amount of 0, and keeps that member in the split', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await recorded(
        ada.token,
        groupId,
        body({
          splitExactly: [
            { memberId: ada.id, amount: 1000 },
            { memberId: grace.id, amount: 0 },
          ],
        }),
      );
      expect((await readExpense(ada.token, id)).shares).toEqual([
        { memberId: ada.id, amount: 1000 },
        { memberId: grace.id, amount: 0 },
      ]);
    });

    it('refuses amounts that do not add up to the amount of the expense, with 422, and records nothing', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const response = await record(
        ada.token,
        groupId,
        body({
          splitExactly: [
            { memberId: ada.id, amount: 400 },
            { memberId: grace.id, amount: 500 },
          ],
        }),
      );
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('SharesDoNotAddUp');
      expect((await balancesOf(ada.token, groupId)).map(row => row.balance)).toEqual([0, 0, 0]);
    });

    it('refuses a negative amount, and a fraction, with 422', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const negative = await record(
        ada.token,
        groupId,
        body({
          splitExactly: [
            { memberId: ada.id, amount: 1100 },
            { memberId: grace.id, amount: -100 },
          ],
        }),
      );
      const fraction = await record(
        ada.token,
        groupId,
        body({
          splitExactly: [
            { memberId: ada.id, amount: 999.5 },
            { memberId: grace.id, amount: 0.5 },
          ],
        }),
      );
      expect(negative.statusCode).toBe(422);
      expect(negative.json().type).toBe('InvalidShareAmount');
      expect(fraction.statusCode).toBe(422);
      expect(fraction.json().type).toBe('InvalidShareAmount');
    });

    it('refuses an amount that is sent as a string, with 400', async () => {
      const { ada, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, body({ splitExactly: [{ memberId: ada.id, amount: '1000' }] }));
      expect(response.statusCode).toBe(400);
    });

    it('applies the same member rules: a payer left out, a member listed twice, a stranger, or none, with 422', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const cases: [Record<string, unknown>, string][] = [
        [{ splitExactly: [{ memberId: grace.id, amount: 1000 }] }, 'PayerNotInSplit'],
        [
          {
            splitExactly: [
              { memberId: ada.id, amount: 500 },
              { memberId: ada.id, amount: 500 },
            ],
          },
          'InvalidSplit',
        ],
        [
          {
            splitExactly: [
              { memberId: ada.id, amount: 500 },
              { memberId: eve.id, amount: 500 },
            ],
          },
          'NotAMember',
        ],
        [{ splitExactly: [] }, 'InvalidSplit'],
      ];
      for (const [split, type] of cases) {
        const response = await record(ada.token, groupId, body(split));
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe(type);
      }
    });
  });

  describe('by shares', () => {
    it('gives 1000 by shares of 1, 1 and 1 the equal split: 334, 333, 333 with the remainder to the payer', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = await recorded(
        ada.token,
        groupId,
        body({
          splitByShares: [
            { memberId: ada.id, shares: 1 },
            { memberId: grace.id, shares: 1 },
            { memberId: linus.id, shares: 1 },
          ],
        }),
      );
      const expense = await readExpense(ada.token, id);
      expect(expense.splitKind).toBe('shares');
      expect(expense.shares).toEqual([
        { memberId: ada.id, amount: 334 },
        { memberId: grace.id, amount: 333 },
        { memberId: linus.id, amount: 333 },
      ]);
    });

    it('gives 1001 by shares of 2 and 1, the payer listed second, 667 and 334', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await recorded(
        ada.token,
        groupId,
        body({
          amount: 1001,
          splitByShares: [
            { memberId: grace.id, shares: 2 },
            { memberId: ada.id, shares: 1 },
          ],
        }),
      );
      const expense = await readExpense(ada.token, id);
      expect(expense.shares).toEqual([
        { memberId: grace.id, amount: 667 },
        { memberId: ada.id, amount: 334 },
      ]);
    });

    it('gives the remainder to the payer even when the payer is not the one with the most shares', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      // 100 by 1, 1 and 1: 33 each, the remainder of 1 to the payer, Grace.
      const id = await recorded(
        grace.token,
        groupId,
        body({
          amount: 100,
          splitByShares: [
            { memberId: ada.id, shares: 1 },
            { memberId: grace.id, shares: 1 },
            { memberId: linus.id, shares: 1 },
          ],
        }),
      );
      expect((await readExpense(ada.token, id)).shares).toEqual([
        { memberId: ada.id, amount: 33 },
        { memberId: grace.id, amount: 34 },
        { memberId: linus.id, amount: 33 },
      ]);
    });

    it('always adds up to the amount exactly, for any shares', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const cases: [number, number[]][] = [
        [99_999_999, [3, 5, 7]],
        [1, [1, 1, 1]],
        [777, [10, 1, 1]],
        [100_000_000, [1, 2, 4]],
      ];
      for (const [amount, shares] of cases) {
        const id = await recorded(
          ada.token,
          groupId,
          body({
            amount,
            splitByShares: [ada.id, grace.id, linus.id].map((memberId, i) => ({ memberId, shares: shares[i] })),
          }),
        );
        const total = (await readExpense(ada.token, id)).shares.reduce((sum, share) => sum + share.amount, 0);
        expect(total).toBe(amount);
      }
    });

    it('gives each member the amount times their shares over the total, rounded down, without overflowing', async () => {
      const { ada, grace, groupId } = await threeMembers();
      // 1000 by a huge number of shares to Ada and one to Grace: Grace's floor is 0, so the
      // remainder of 1 goes to Grace as payer.
      const id = await recorded(
        grace.token,
        groupId,
        body({
          splitByShares: [
            { memberId: ada.id, shares: 1_000_000_000_000_000 },
            { memberId: grace.id, shares: 1 },
          ],
        }),
      );
      expect((await readExpense(ada.token, id)).shares).toEqual([
        { memberId: ada.id, amount: 999 },
        { memberId: grace.id, amount: 1 },
      ]);
    });

    it('refuses a member with fewer than 1 share, with 422, and records nothing', async () => {
      const { ada, grace, groupId } = await threeMembers();
      for (const shares of [0, -1]) {
        const response = await record(
          ada.token,
          groupId,
          body({
            splitByShares: [
              { memberId: ada.id, shares: 1 },
              { memberId: grace.id, shares },
            ],
          }),
        );
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('InvalidShares');
      }
      expect((await balancesOf(ada.token, groupId)).map(row => row.balance)).toEqual([0, 0, 0]);
    });

    it('applies the same member rules as the other splits, with 422', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, body({ splitByShares: [{ memberId: grace.id, shares: 2 }] }));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('PayerNotInSplit');
    });
  });

  describe('the balances count every share, however it was split', () => {
    it('counts the exact amounts and the shares in the balances, and they still add up to 0', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      await recorded(
        ada.token,
        groupId,
        body({
          amount: 900,
          splitExactly: [
            { memberId: ada.id, amount: 500 },
            { memberId: grace.id, amount: 400 },
          ],
        }),
      );
      await recorded(
        grace.token,
        groupId,
        body({
          amount: 300,
          splitByShares: [
            { memberId: linus.id, shares: 2 },
            { memberId: grace.id, shares: 1 },
          ],
        }),
      );
      // Ada paid 900 and owes 500: +400. Grace paid 300, owes 400 (exact) and 100 (shares): -200.
      // Linus owes 200 (shares). Grace's 1 share of 300 by 2 and 1 is 100; Linus's 2 shares is 200.
      const balances = await balancesOf(ada.token, groupId);
      expect(balances).toEqual([
        { memberId: ada.id, balance: 400 },
        { memberId: grace.id, balance: -200 },
        { memberId: linus.id, balance: -200 },
      ]);
      expect(balances.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
    });
  });

  describe('an edit may change the kind of split', () => {
    it('changes the split and the way it is read, from equal to exact to shares, and counts a new version', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await recorded(ada.token, groupId, body({ splitBetween: [ada.id, grace.id] }));
      expect((await readExpense(ada.token, id)).splitKind).toBe('equal');

      const toExact = await putEdit(
        ada.token,
        id,
        editBody(1, {
          splitExactly: [
            { memberId: ada.id, amount: 700 },
            { memberId: grace.id, amount: 300 },
          ],
        }),
      );
      expect(toExact.statusCode).toBe(204);
      const exact = await readExpense(ada.token, id);
      expect(exact).toMatchObject({ splitKind: 'exact', version: 2 });
      expect(exact.shares).toEqual([
        { memberId: ada.id, amount: 700 },
        { memberId: grace.id, amount: 300 },
      ]);

      const toShares = await putEdit(
        ada.token,
        id,
        editBody(2, {
          splitByShares: [
            { memberId: grace.id, shares: 1 },
            { memberId: ada.id, shares: 3 },
          ],
        }),
      );
      expect(toShares.statusCode).toBe(204);
      const shares = await readExpense(ada.token, id);
      expect(shares).toMatchObject({ splitKind: 'shares', version: 3 });
      expect(shares.shares).toEqual([
        { memberId: grace.id, amount: 250 },
        { memberId: ada.id, amount: 750 },
      ]);
    });

    it('refuses an edit whose exact amounts do not add up, with 422, and keeps the expense as it was', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await recorded(ada.token, groupId, body({ splitBetween: [ada.id, grace.id] }));
      const before = await readExpense(ada.token, id);
      const refused = await putEdit(
        ada.token,
        id,
        editBody(1, {
          splitExactly: [
            { memberId: ada.id, amount: 1 },
            { memberId: grace.id, amount: 1 },
          ],
        }),
      );
      expect(refused.statusCode).toBe(422);
      expect(refused.json().type).toBe('SharesDoNotAddUp');
      expect(await readExpense(ada.token, id)).toEqual(before);
    });
  });

  describe('a read', () => {
    it('gives the same split on every read, and changes nothing', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = await recorded(
        ada.token,
        groupId,
        body({
          splitByShares: [
            { memberId: linus.id, shares: 1 },
            { memberId: ada.id, shares: 1 },
          ],
        }),
      );
      const first = await readExpense(grace.token, id);
      const second = await readExpense(grace.token, id);
      expect(second).toEqual(first);
      expect(first.version).toBe(1);
    });

    it('keeps the kind of split when the application stops and starts again on the same file', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = await recorded(
        ada.token,
        groupId,
        body({
          splitExactly: [
            { memberId: ada.id, amount: 600 },
            { memberId: grace.id, amount: 400 },
          ],
        }),
      );
      await app.stop();
      app = await createApplication({ databasePath });
      expect((await readExpense(grace.token, id)).splitKind).toBe('exact');
    });
  });
});
