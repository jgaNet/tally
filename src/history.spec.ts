import { DatabaseSync } from 'node:sqlite';
import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const DAY_1 = '2026-11-01';
const DAY_2 = '2026-11-02';

describe('history', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
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

  /** Records an expense of the group, paid by the account that signs the request with `token`. */
  async function record(token: string, fields: Record<string, unknown>): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Expense', date: DAY_1, ...fields },
      token,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  /**
   * Edits an expense from the version read by a GET of it, giving it whole: its current split between the
   * same members, unless the fields give another split.
   */
  async function edit(expenseId: string, token: string, fields: Record<string, unknown>): Promise<void> {
    const current = (await call(app, 'GET', `/expenses/${expenseId}`, { token })).body;
    const givesOwnSplit = 'splitExactly' in fields || 'splitByShares' in fields;
    const currentSplit = givesOwnSplit
      ? {}
      : { splitBetween: current.shares.map((share: { memberId: string }) => share.memberId) };
    const answer = await call(app, 'PUT', `/expenses/${expenseId}`, {
      body: {
        description: current.description,
        amount: current.amount,
        date: current.date,
        version: current.version,
        ...currentSplit,
        ...fields,
      },
      token,
    });
    expect(answer.status).toBe(204);
  }

  const listed = (token = adaToken, using: Application = app) =>
    call(using, 'GET', `/groups/${groupId}/expenses`, { token });

  const statement = (memberId: string, token = adaToken, using: Application = app) =>
    call(using, 'GET', `/groups/${groupId}/members/${memberId}/statement`, { token });

  const balances = (token = adaToken) => call(app, 'GET', `/groups/${groupId}/balances`, { token });

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.path);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    await app.stop();
    database.remove();
  });

  describe("the group's expenses", () => {
    it('answers an empty list when nothing is recorded', async () => {
      expect(await listed()).toEqual({ status: 200, body: [] });
    });

    it('lists the latest date first, and on the same date the most recently recorded first', async () => {
      const older = await record(adaToken, { amount: 100, date: DAY_1, splitBetween: [adaId] });
      const earlierSameDay = await record(adaToken, { amount: 200, date: DAY_2, splitBetween: [adaId] });
      const laterSameDay = await record(graceToken, { amount: 300, date: DAY_2, splitBetween: [graceId] });
      const latest = await record(linusToken, { amount: 400, date: '2026-11-03', splitBetween: [linusId] });

      const answer = await listed();
      expect(answer.status).toBe(200);
      expect(answer.body.map((expense: { id: string }) => expense.id)).toEqual([
        latest,
        laterSameDay,
        earlierSameDay,
        older,
      ]);
    });

    it('answers each expense as reading it by its id answers', async () => {
      const first = await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
      const second = await record(graceToken, { amount: 700, date: DAY_2, splitBetween: [graceId, linusId] });
      const answer = await listed(graceToken);
      for (const id of [first, second]) {
        const read = await call(app, 'GET', `/expenses/${id}`, { token: graceToken });
        expect(answer.body).toContainEqual(read.body);
      }
      expect(answer.body.find((expense: { id: string }) => expense.id === first)).toEqual({
        id: first,
        groupId,
        description: 'Expense',
        amount: 1000,
        date: DAY_1,
        paidBy: adaId,
        shares: [
          { memberId: adaId, amount: 334 },
          { memberId: graceId, amount: 333 },
          { memberId: linusId, amount: 333 },
        ],
        splitKind: 'equal',
        category: 'other',
        version: 1,
      });
    });

    it('keeps an edited expense where it was recorded: an edit does not change when it was recorded', async () => {
      const first = await record(adaToken, { amount: 500, date: DAY_2, splitBetween: [adaId] });
      const second = await record(adaToken, { amount: 600, date: DAY_2, splitBetween: [adaId] });
      const third = await record(adaToken, { amount: 700, date: DAY_2, splitBetween: [adaId] });
      // The first one, edited, is still the least recently recorded of its day: it does not move up.
      await edit(first, adaToken, { amount: 550 });
      const ids = (await listed()).body.map((expense: { id: string }) => expense.id);
      expect(ids).toEqual([third, second, first]);
      expect((await listed()).body[2]).toMatchObject({ id: first, amount: 550, version: 2 });
    });

    it('moves an edited expense of an earlier date to its new date, among the others of that date', async () => {
      const older = await record(adaToken, { amount: 500, date: DAY_1, splitBetween: [adaId] });
      const newer = await record(adaToken, { amount: 600, date: DAY_2, splitBetween: [adaId] });
      await edit(older, adaToken, { date: '2026-11-03' });
      expect((await listed()).body.map((expense: { id: string }) => expense.id)).toEqual([older, newer]);
    });

    it('leaves out the expenses that are deleted', async () => {
      const kept = await record(adaToken, { amount: 500, splitBetween: [adaId] });
      const gone = await record(adaToken, { amount: 600, splitBetween: [adaId] });
      expect((await call(app, 'DELETE', `/expenses/${gone}`, { token: adaToken })).status).toBe(204);
      expect((await listed()).body.map((expense: { id: string }) => expense.id)).toEqual([kept]);
    });

    it('leaves out the expenses of other groups', async () => {
      const other = (
        await call(app, 'POST', '/groups', { body: { name: 'Elsewhere', currency: 'GBP' }, token: adaToken })
      ).body.id;
      await call(app, 'POST', `/groups/${other}/expenses`, {
        body: { description: 'Elsewhere', amount: 5000, date: DAY_1, splitBetween: [adaId] },
        token: adaToken,
      });
      expect((await listed()).body).toEqual([]);
    });

    it('lets every member of the group read the list, and it answers the same to each', async () => {
      await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
      const fromOwner = (await listed(adaToken)).body;
      expect(fromOwner).toHaveLength(1);
      expect((await listed(graceToken)).body).toEqual(fromOwner);
      expect((await listed(linusToken)).body).toEqual(fromOwner);
    });

    it('answers 404 to an account outside the group, as if the group did not exist', async () => {
      const outsider = await accountOf(outsiderAccount);
      const notMember = await listed(outsider.token);
      const missing = await call(app, 'GET', '/groups/no-such-group/expenses', { token: outsider.token });
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      expect((await call(app, 'GET', `/groups/${groupId}/expenses`)).status).toBe(401);
      expect((await listed('made-up-token')).status).toBe(401);
    });
  });

  describe("a member's statement", () => {
    /**
     * Three expenses, recorded in this order:
     *   E1, 2026-11-02, Ada paid 900, split equally among all three (300 each);
     *   E2, 2026-11-01, Grace paid 600, split equally between Grace and Linus (300 each);
     *   E3, 2026-11-02, Linus paid 100, split only on Linus (100).
     */
    async function threeExpenses() {
      const e1 = await record(adaToken, { amount: 900, date: DAY_2, splitBetween: [adaId, graceId, linusId] });
      const e2 = await record(graceToken, { amount: 600, date: DAY_1, splitBetween: [graceId, linusId] });
      const e3 = await record(linusToken, { amount: 100, date: DAY_2, splitBetween: [linusId] });
      return { e1, e2, e3 };
    }

    it('answers the entries the earliest date first, and on the same date the earliest recorded first', async () => {
      const { e1, e2, e3 } = await threeExpenses();
      const graceStatement = (await statement(graceId)).body;
      expect(graceStatement.entries.map((entry: { expenseId: string }) => entry.expenseId)).toEqual([e2, e1]);
      const linusStatement = (await statement(linusId)).body;
      expect(linusStatement.entries.map((entry: { expenseId: string }) => entry.expenseId)).toEqual([e2, e1, e3]);
    });

    it('answers what the member paid, their share, and their balance after each entry, starting from 0', async () => {
      const { e1, e2, e3 } = await threeExpenses();
      expect(await statement(graceId)).toEqual({
        status: 200,
        body: {
          memberId: graceId,
          balance: 0,
          entries: [
            { expenseId: e2, date: DAY_1, description: 'Expense', paid: 600, share: 300, balance: 300 },
            { expenseId: e1, date: DAY_2, description: 'Expense', paid: 0, share: 300, balance: 0 },
          ],
        },
      });
      expect((await statement(linusId)).body).toEqual({
        memberId: linusId,
        balance: -600,
        entries: [
          { expenseId: e2, date: DAY_1, description: 'Expense', paid: 0, share: 300, balance: -300 },
          { expenseId: e1, date: DAY_2, description: 'Expense', paid: 0, share: 300, balance: -600 },
          { expenseId: e3, date: DAY_2, description: 'Expense', paid: 100, share: 100, balance: -600 },
        ],
      });
    });

    it('leaves out the expenses the member neither paid nor is in the split of', async () => {
      const { e1 } = await threeExpenses();
      expect((await statement(adaId)).body).toEqual({
        memberId: adaId,
        balance: 600,
        entries: [
          {
            expenseId: e1,
            date: DAY_2,
            description: 'Expense',
            paid: 900,
            share: 300,
            balance: 600,
          },
        ],
      });
    });

    it('answers an entry with a share of 0 when the member is in the split for nothing', async () => {
      const exact = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        body: {
          description: 'Exact',
          amount: 500,
          date: DAY_1,
          splitExactly: [
            { memberId: adaId, amount: 500 },
            { memberId: graceId, amount: 0 },
          ],
        },
        token: adaToken,
      });
      expect(exact.status).toBe(201);
      expect((await statement(graceId)).body).toEqual({
        memberId: graceId,
        balance: 0,
        entries: [{ expenseId: exact.body.id, date: DAY_1, description: 'Exact', paid: 0, share: 0, balance: 0 }],
      });
    });

    it('answers a member with no entry an empty statement, with a balance of 0', async () => {
      await record(adaToken, { amount: 500, splitBetween: [adaId] });
      expect(await statement(linusId)).toEqual({
        status: 200,
        body: { memberId: linusId, balance: 0, entries: [] },
      });
    });

    it('leaves out the expenses that are deleted', async () => {
      const { e1, e2 } = await threeExpenses();
      expect((await call(app, 'DELETE', `/expenses/${e2}`, { token: graceToken })).status).toBe(204);
      expect((await statement(graceId)).body).toEqual({
        memberId: graceId,
        balance: -300,
        entries: [{ expenseId: e1, date: DAY_2, description: 'Expense', paid: 0, share: 300, balance: -300 }],
      });
    });

    it('keeps an edited expense where it was recorded, and shows its edited amounts', async () => {
      const { e1, e2, e3 } = await threeExpenses();
      // E2 moves to E1's date: it was recorded after E1, so on that day it comes after E1 and before E3.
      await edit(e2, graceToken, { date: DAY_2 });
      expect((await statement(linusId)).body.entries.map((entry: { expenseId: string }) => entry.expenseId)).toEqual([
        e1,
        e2,
        e3,
      ]);
      // E1 is edited to split 800 for Ada and 100 for Grace: Grace's share changes from 300 to 100.
      await edit(e1, adaToken, {
        splitExactly: [
          { memberId: adaId, amount: 800 },
          { memberId: graceId, amount: 100 },
        ],
      });
      expect(await statement(graceId)).toEqual({
        status: 200,
        body: {
          memberId: graceId,
          balance: 200,
          entries: [
            { expenseId: e1, date: DAY_2, description: 'Expense', paid: 0, share: 100, balance: -100 },
            { expenseId: e2, date: DAY_2, description: 'Expense', paid: 600, share: 300, balance: 200 },
          ],
        },
      });
    });

    it('answers a balance that is the one the group balances give the member, after any mix of expenses', async () => {
      await threeExpenses();
      await record(graceToken, { amount: 1001, splitBetween: [adaId, graceId, linusId] });
      await record(adaToken, {
        amount: 7,
        splitExactly: [
          { memberId: adaId, amount: 3 },
          { memberId: linusId, amount: 4 },
        ],
      });
      const rows = (await balances()).body as { memberId: string; balance: number }[];
      for (const row of rows) {
        const answer = (await statement(row.memberId)).body;
        expect(answer.balance).toBe(row.balance);
        const last = answer.entries.at(-1);
        expect(answer.balance).toBe(last ? last.balance : 0);
      }
    });

    it('lets every member of the group read any statement of the group, and they answer the same', async () => {
      await threeExpenses();
      for (const memberId of [adaId, graceId, linusId]) {
        const fromOwner = (await statement(memberId, adaToken)).body;
        expect((await statement(memberId, graceToken)).body).toEqual(fromOwner);
        expect((await statement(memberId, linusToken)).body).toEqual(fromOwner);
      }
    });

    it('answers 404 to an account outside the group, as if the group did not exist', async () => {
      await threeExpenses();
      const outsider = await accountOf(outsiderAccount);
      const notMember = await statement(graceId, outsider.token);
      const missing = await call(app, 'GET', `/groups/no-such-group/members/${graceId}/statement`, {
        token: outsider.token,
      });
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 404 for someone who has never been a member of the group', async () => {
      const outsider = await accountOf(outsiderAccount);
      const answer = await statement(outsider.id);
      expect(answer).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect((await statement('no-such-member')).status).toBe(404);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      expect((await call(app, 'GET', `/groups/${groupId}/members/${adaId}/statement`)).status).toBe(401);
      expect((await statement(adaId, 'made-up-token')).status).toBe(401);
    });

    it('changes nothing that is stored: reading the list and the statements leaves the rows as they were', async () => {
      await threeExpenses();
      const counts = () => {
        const probe = new DatabaseSync(database.path);
        try {
          const count = (table: string) =>
            (probe.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
          return ['expenses', 'expense_shares', 'group_members', 'accounts', 'groups'].map(count);
        } finally {
          probe.close();
        }
      };
      const before = counts();
      const first = [(await listed()).body, (await statement(graceId)).body];
      expect([(await listed()).body, (await statement(graceId)).body]).toEqual(first);
      expect(counts()).toEqual(before);
    });
  });
});
