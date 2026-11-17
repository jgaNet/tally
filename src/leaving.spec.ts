import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';

describe('leaving a group', () => {
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

  /** Brings the account into the group by an invitation of the owner, and accepts it. */
  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  /** Records an expense of the group, paid by the account that signs the request with `token`. */
  async function record(token: string, fields: Record<string, unknown>): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Expense', date: PAST_DAY, ...fields },
      token,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  const leave = (token: string, id = groupId) => call(app, 'POST', `/groups/${id}/leave`, { token });
  const balances = (token = adaToken) => call(app, 'GET', `/groups/${groupId}/balances`, { token });
  const members = (token = adaToken) => call(app, 'GET', `/groups/${groupId}/members`, { token });

  /** The balances answered, as a map from member to balance. */
  const asMap = (rows: { memberId: string; balance: number }[]) =>
    Object.fromEntries(rows.map(row => [row.memberId, row.balance]));

  /**
   * Grace paid 1000 split equally between Ada and Grace, so Grace is owed 500; then Ada paid 500, all of
   * it on Grace's share. Ada's and Grace's balances are both 0.
   */
  async function evenedGrace(): Promise<{ graceExpense: string; adaExpense: string }> {
    const graceExpense = await record(graceToken, { amount: 1000, splitBetween: [adaId, graceId] });
    const adaExpense = await record(adaToken, {
      amount: 500,
      splitExactly: [
        { memberId: adaId, amount: 0 },
        { memberId: graceId, amount: 500 },
      ],
    });
    expect(asMap((await balances()).body)[graceId]).toBe(0);
    return { graceExpense, adaExpense };
  }

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

  describe('leaving', () => {
    it('answers 204 to a member whose balance is 0, and the member is then no longer in the group', async () => {
      await evenedGrace();
      expect((await leave(graceToken)).status).toBe(204);

      const memberIds = (await members()).body.map((row: { memberId: string }) => row.memberId);
      expect(memberIds).toEqual([adaId, linusId]);
      expect(Object.keys(asMap((await balances()).body))).toEqual([adaId, linusId]);
    });

    it('takes the group out of the groups of the leaver, and leaves it in the groups of the others', async () => {
      await evenedGrace();
      await leave(graceToken);

      expect((await call(app, 'GET', '/groups/mine', { token: graceToken })).body).toEqual([]);
      expect(
        (await call(app, 'GET', '/groups/mine', { token: adaToken })).body.map((g: { id: string }) => g.id),
      ).toEqual([groupId]);
    });

    it('lets the leaver read nothing of the group any more, as if it did not exist for them', async () => {
      const { graceExpense } = await evenedGrace();
      await leave(graceToken);

      expect((await call(app, 'GET', `/groups/${groupId}`, { token: graceToken })).status).toBe(404);
      expect((await call(app, 'GET', `/groups/${groupId}/members`, { token: graceToken })).status).toBe(404);
      expect((await call(app, 'GET', `/groups/${groupId}/balances`, { token: graceToken })).status).toBe(404);
      expect((await call(app, 'GET', `/groups/${groupId}/expenses`, { token: graceToken })).status).toBe(404);
      expect((await call(app, 'GET', `/expenses/${graceExpense}`, { token: graceToken })).status).toBe(404);
      expect((await call(app, 'POST', `/groups/${groupId}/invitations`, { token: graceToken })).status).toBe(404);
    });

    it('refuses a leave of a member who has left already, as the group does not exist for them', async () => {
      await evenedGrace();
      await leave(graceToken);
      expect(await leave(graceToken)).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
    });

    it('lets a member leave at a balance that is not 0, with 204, and the owner takes over what they owed', async () => {
      // Ada paid 600 for herself, Grace and Linus, 300 each for the two of them: Ada is owed 600, Grace and Linus owe 300.
      await record(adaToken, {
        amount: 600,
        splitExactly: [
          { memberId: adaId, amount: 0 },
          { memberId: graceId, amount: 300 },
          { memberId: linusId, amount: 300 },
        ],
      });
      expect(asMap((await balances()).body)).toEqual({ [adaId]: 600, [graceId]: -300, [linusId]: -300 });

      expect((await leave(graceToken)).status).toBe(204);
      expect(asMap((await balances()).body)).toEqual({ [adaId]: 300, [linusId]: -300 });
      expect((await members()).body.map((row: { memberId: string }) => row.memberId)).toEqual([adaId, linusId]);
    });

    it('lets a member leave who is owed money, and the owner takes over the debt owed to the member', async () => {
      // Grace paid 600 for herself and Ada: Grace is owed 300, Ada owes 300.
      await record(graceToken, { amount: 600, splitBetween: [adaId, graceId] });
      expect((await leave(graceToken)).status).toBe(204);
      expect(asMap((await balances()).body)).toEqual({ [adaId]: 0, [linusId]: 0 });
    });

    it('keeps the balances of the group at a total of 0 when a member with a balance leaves', async () => {
      await record(linusToken, { amount: 900, splitBetween: [adaId, graceId, linusId] });
      await record(graceToken, { amount: 400, splitBetween: [graceId, linusId] });
      expect(Object.values(asMap((await balances()).body)).reduce((sum, value) => sum + value, 0)).toBe(0);

      expect((await leave(graceToken)).status).toBe(204);
      const rows = (await balances()).body as { memberId: string; balance: number }[];
      expect(rows.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
    });

    it('refuses the owner, with 403, and keeps the owner in the group even at a balance of 0', async () => {
      expect(await leave(adaToken)).toEqual({
        status: 403,
        body: { type: 'OwnerCannotLeave', message: expect.any(String) },
      });
      expect((await members()).body[0]).toMatchObject({ memberId: adaId, role: 'owner' });
    });

    it('answers 404 to an account that is not a member of the group, and 401 to a request without a token', async () => {
      const outsider = await accountOf(outsiderAccount);
      expect((await leave(outsider.token)).status).toBe(404);
      expect((await call(app, 'POST', `/groups/${groupId}/leave`)).status).toBe(401);
    });

    it('answers 404 to a group that does not exist', async () => {
      expect((await leave(graceToken, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    });

    it('keeps the balances of the group at a total of 0 after a member leaves', async () => {
      await evenedGrace();
      await record(linusToken, { amount: 300, splitBetween: [adaId, linusId] });
      await leave(graceToken);

      const rows = (await balances()).body as { memberId: string; balance: number }[];
      expect(rows.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
      expect(rows.map(row => row.memberId)).toEqual([adaId, linusId]);
    });

    it('keeps the expenses the leaver was in, with their shares, as they were', async () => {
      const { graceExpense, adaExpense } = await evenedGrace();
      const before = (await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken })).body;
      await leave(graceToken);
      const after = (await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken })).body;

      expect(after).toEqual(before);
      expect(after.map((expense: { id: string }) => expense.id)).toEqual(
        expect.arrayContaining([graceExpense, adaExpense]),
      );
      const shares = after.find((expense: { id: string }) => expense.id === graceExpense).shares;
      expect(shares).toEqual([
        { memberId: adaId, amount: 500 },
        { memberId: graceId, amount: 500 },
      ]);
    });

    it("keeps the leaver's statement readable by the members of the group, with its entries", async () => {
      const { graceExpense, adaExpense } = await evenedGrace();
      await leave(graceToken);

      const answer = await call(app, 'GET', `/groups/${groupId}/members/${graceId}/statement`, { token: adaToken });
      expect(answer.status).toBe(200);
      expect(answer.body.memberId).toBe(graceId);
      expect(answer.body.balance).toBe(0);
      expect(answer.body.entries.map((entry: { expenseId: string }) => entry.expenseId)).toEqual([
        graceExpense,
        adaExpense,
      ]);
    });

    it('answers 404 to the statement of an account that was never a member of the group', async () => {
      const outsider = await accountOf(outsiderAccount);
      const answer = await call(app, 'GET', `/groups/${groupId}/members/${outsider.id}/statement`, { token: adaToken });
      expect(answer.status).toBe(404);
    });
  });

  describe('an expense of a member who has left', () => {
    beforeEach(async () => {
      await evenedGrace();
      await leave(graceToken);
    });

    it('refuses an edit by the owner of an expense whose payer has left, with 409, and keeps the expense', async () => {
      const graceExpense = (await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken })).body.find(
        (expense: { paidBy: string }) => expense.paidBy === graceId,
      );
      const answer = await call(app, 'PUT', `/expenses/${graceExpense.id}`, {
        token: adaToken,
        body: { description: 'Changed', amount: 1000, date: PAST_DAY, version: 1, splitBetween: [adaId, graceId] },
      });
      expect(answer).toEqual({ status: 409, body: { type: 'ExpenseOfFormerMember', message: expect.any(String) } });
      expect((await call(app, 'GET', `/expenses/${graceExpense.id}`, { token: adaToken })).body.description).toBe(
        'Expense',
      );
    });

    it('refuses a delete of an expense the leaver was in the split of, with 409, and keeps the expense', async () => {
      const adaExpense = (await call(app, 'GET', `/groups/${groupId}/expenses`, { token: adaToken })).body.find(
        (expense: { paidBy: string; shares: { memberId: string }[] }) =>
          expense.paidBy === adaId && expense.shares.some(share => share.memberId === graceId),
      );
      const answer = await call(app, 'DELETE', `/expenses/${adaExpense.id}`, { token: adaToken });
      expect(answer.status).toBe(409);
      expect(answer.body.type).toBe('ExpenseOfFormerMember');
      expect((await call(app, 'GET', `/expenses/${adaExpense.id}`, { token: adaToken })).status).toBe(200);
    });

    it('still lets the members change an expense that does not concern the leaver', async () => {
      const linusExpense = await record(linusToken, { amount: 300, splitBetween: [adaId, linusId] });
      const answer = await call(app, 'PUT', `/expenses/${linusExpense}`, {
        token: linusToken,
        body: { description: 'Changed', amount: 300, date: PAST_DAY, version: 1, splitBetween: [adaId, linusId] },
      });
      expect(answer.status).toBe(204);
      expect((await call(app, 'DELETE', `/expenses/${linusExpense}`, { token: adaToken })).status).toBe(204);
    });

    it('refuses to put the leaver in the split of a new expense, with 422', async () => {
      const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        token: adaToken,
        body: { description: 'Dinner', amount: 300, date: PAST_DAY, splitBetween: [adaId, graceId] },
      });
      expect(answer.status).toBe(422);
      expect(answer.body.type).toBe('InvalidSplit');
    });

    it('refuses the leaver a new expense, as the group does not exist for them', async () => {
      const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
        token: graceToken,
        body: { description: 'Dinner', amount: 300, date: PAST_DAY, splitBetween: [graceId, adaId] },
      });
      expect(answer.status).toBe(404);
    });
  });

  describe('joining again', () => {
    it('makes the leaver a member again, last in the order of the members, with a balance of 0', async () => {
      await evenedGrace();
      await leave(graceToken);
      await join(graceToken);

      const rows = (await members()).body;
      expect(rows.map((row: { memberId: string }) => row.memberId)).toEqual([adaId, linusId, graceId]);
      expect(rows[2]).toMatchObject({ role: 'member' });
      expect(asMap((await balances()).body)[graceId]).toBe(0);
      expect(
        (await call(app, 'GET', '/groups/mine', { token: graceToken })).body.map((g: { id: string }) => g.id),
      ).toEqual([groupId]);
    });

    it('starts a member who left at a balance and joins again at 0, and the owner keeps what passed to them', async () => {
      await record(adaToken, {
        amount: 600,
        splitExactly: [
          { memberId: adaId, amount: 0 },
          { memberId: graceId, amount: 300 },
          { memberId: linusId, amount: 300 },
        ],
      });
      await leave(graceToken);
      await join(graceToken);

      expect(asMap((await balances()).body)).toEqual({ [adaId]: 300, [linusId]: -300, [graceId]: 0 });
      // What the rejoined member owes from now on counts, and only that.
      await record(linusToken, { amount: 200, splitBetween: [linusId, graceId] });
      expect(asMap((await balances()).body)).toEqual({ [adaId]: 300, [linusId]: -200, [graceId]: -100 });
    });

    it('gives the rejoined member the join time of the rejoin, which is after the one before', async () => {
      const before = (await members()).body.find((row: { memberId: string }) => row.memberId === graceId).joinedAt;
      await evenedGrace();
      await leave(graceToken);
      await join(graceToken);
      const after = (await members()).body.find((row: { memberId: string }) => row.memberId === graceId).joinedAt;
      expect(after > before).toBe(true);
    });

    it('lets the expenses of the rejoined member be edited again, as they concern a member', async () => {
      const { graceExpense } = await evenedGrace();
      await leave(graceToken);
      await join(graceToken);
      const answer = await call(app, 'PUT', `/expenses/${graceExpense}`, {
        token: graceToken,
        body: { description: 'Changed', amount: 1000, date: PAST_DAY, version: 1, splitBetween: [adaId, graceId] },
      });
      expect(answer.status).toBe(204);
    });

    it('keeps the leaver out of the group until they accept an invitation again', async () => {
      await evenedGrace();
      await leave(graceToken);
      expect((await members()).body.map((row: { memberId: string }) => row.memberId)).not.toContain(graceId);
    });
  });
});
