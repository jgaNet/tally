import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Application } from './app';
import { openDatabase } from './database';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };

const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('notices', () => {
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

  /** The notices of the account, as the API answers them. */
  async function noticesOf(token: string) {
    const answer = await call(app, 'GET', '/notices', { token });
    expect(answer.status).toBe(200);
    return answer.body as Array<{
      id: string;
      kind: string;
      groupId: string;
      expenseId: string;
      amount: number;
      at: string;
    }>;
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

  const expense = (fields: Record<string, unknown> = {}) => ({
    description: 'Pizzas',
    amount: 1000,
    date: '2026-11-01',
    splitBetween: [adaId, graceId, linusId],
    ...fields,
  });

  /** Records an expense of the group by the account, and answers its id. */
  async function recordExpense(fields: Record<string, unknown> = {}, token = adaToken): Promise<string> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, { body: expense(fields), token });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  it('gives each member of the split but the payer a notice with their share, at once', async () => {
    const expenseId = await recordExpense();

    const graceNotices = await noticesOf(graceToken);
    expect(graceNotices).toEqual([
      {
        id: expect.any(String),
        kind: 'expense',
        groupId,
        expenseId,
        amount: 333,
        at: expect.stringMatching(AT_PATTERN),
      },
    ]);
    const linusNotices = await noticesOf(linusToken);
    expect(linusNotices).toHaveLength(1);
    expect(linusNotices[0]).toMatchObject({ kind: 'expense', expenseId, amount: 333 });
  });

  it('gives the payer no notice: they recorded the expense', async () => {
    await recordExpense();

    expect(await noticesOf(adaToken)).toEqual([]);
  });

  it('gives a member outside the split no notice', async () => {
    await recordExpense({ splitBetween: [adaId, graceId] });

    expect(await noticesOf(linusToken)).toEqual([]);
    expect(await noticesOf(graceToken)).toHaveLength(1);
  });

  it('gives each member the share of an unequal split, by amounts', async () => {
    const expenseId = await recordExpense({
      splitBetween: undefined,
      splitExactly: [
        { memberId: adaId, amount: 600 },
        { memberId: graceId, amount: 400 },
        { memberId: linusId, amount: 0 },
      ],
    });

    expect(await noticesOf(graceToken)).toMatchObject([{ expenseId, amount: 400 }]);
    expect(await noticesOf(linusToken)).toMatchObject([{ expenseId, amount: 0 }]);
  });

  it('gives each member the share of a split by shares', async () => {
    const expenseId = await recordExpense({
      splitBetween: undefined,
      splitByShares: [
        { memberId: adaId, shares: 1 },
        { memberId: graceId, shares: 3 },
      ],
      amount: 1000,
    });

    expect(await noticesOf(graceToken)).toMatchObject([{ expenseId, amount: 750 }]);
    expect(await noticesOf(linusToken)).toEqual([]);
  });

  it('lists the notices most recent first', async () => {
    const first = await recordExpense({ description: 'Pizzas' });
    const second = await recordExpense({ description: 'Wine' });

    const expenseIds = (await noticesOf(graceToken)).map(notice => notice.expenseId);
    expect(expenseIds).toEqual([second, first]);
  });

  it('makes no notice when an expense is edited or deleted', async () => {
    const expenseId = await recordExpense();
    const edited = await call(app, 'PUT', `/expenses/${expenseId}`, {
      body: expense({ amount: 1500, version: 1 }),
      token: adaToken,
    });
    expect(edited.status).toBe(204);

    expect(await noticesOf(graceToken)).toHaveLength(1);

    const deleted = await call(app, 'DELETE', `/expenses/${expenseId}`, { token: adaToken });
    expect(deleted.status).toBe(204);

    expect(await noticesOf(graceToken)).toHaveLength(1);
    expect(await noticesOf(linusToken)).toHaveLength(1);
  });

  it('keeps exactly one notice per member when the server is stopped and started again', async () => {
    const expenseId = await recordExpense();
    await app.stop();
    app = await startApplication(database.path);

    const graceNotices = await noticesOf(graceToken);
    expect(graceNotices).toMatchObject([{ expenseId, amount: 333 }]);
    expect(await noticesOf(linusToken)).toMatchObject([{ expenseId, amount: 333 }]);
  });

  it('refuses a second notice for the same member and expense', async () => {
    const expenseId = await recordExpense();
    const other: DatabaseSync = openDatabase(database.path);
    try {
      expect(() =>
        other
          .prepare(
            `INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
             SELECT ?, account_id, kind, group_id, expense_id, amount, created_at FROM notices WHERE expense_id = ? LIMIT 1`,
          )
          .run(randomUUID(), expenseId),
      ).toThrow(/UNIQUE/);
    } finally {
      other.close();
    }
    expect(await noticesOf(graceToken)).toHaveLength(1);
  });

  it('writes no notice for an expense that is refused', async () => {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: expense({
        splitBetween: undefined,
        splitExactly: [
          { memberId: adaId, amount: 100 },
          { memberId: graceId, amount: 100 },
        ],
      }),
      token: adaToken,
    });
    expect(answer.status).toBe(422);

    expect(await noticesOf(graceToken)).toEqual([]);
  });

  it('keeps a notice after its member leaves the group', async () => {
    const expenseId = await recordExpense({
      splitBetween: undefined,
      splitExactly: [
        { memberId: adaId, amount: 1000 },
        { memberId: graceId, amount: 0 },
      ],
    });
    const left = await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken });
    expect(left.status).toBeLessThan(300);

    expect(await noticesOf(graceToken)).toMatchObject([{ expenseId, groupId, amount: 0 }]);
  });

  it('lists to each person only their own notices', async () => {
    const expenseId = await recordExpense({ splitBetween: [adaId, graceId] });

    expect(await noticesOf(graceToken)).toMatchObject([{ expenseId }]);
    expect(await noticesOf(linusToken)).toEqual([]);
    expect(await noticesOf(adaToken)).toEqual([]);
  });

  it('refuses a read without a signed-in account', async () => {
    await recordExpense();

    expect((await call(app, 'GET', '/notices')).status).toBe(401);
    expect((await call(app, 'GET', '/notices', { token: 'not-a-token' })).status).toBe(401);
  });

  it('answers the same notices on every read', async () => {
    await recordExpense();

    const first = await noticesOf(graceToken);
    const second = await noticesOf(graceToken);
    expect(second).toEqual(first);
  });
});
