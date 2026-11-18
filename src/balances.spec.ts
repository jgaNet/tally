import { Application } from './app';
import { countRows } from './test-support';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';

describe('balances', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  const extraApps: Application[] = [];
  let adaId: string;
  let adaToken: string;
  let graceId: string;
  let graceToken: string;
  let linusId: string;
  let linusToken: string;
  let groupId: string;

  /** Signs the account up and in, and answers its id and token. */
  async function accountOf(account: typeof ada, using = app): Promise<{ id: string; token: string }> {
    const id = (await call(using, 'POST', '/accounts', { body: account })).body.id;
    const token = (await call(using, 'POST', '/accounts/login', { body: account })).body.token;
    return { id, token };
  }

  /** Brings the account into the group by an invitation of the owner. */
  async function join(accountToken: string): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: adaToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
  }

  /** Records an expense of the group, paid by the account that signs the request with `token`. */
  async function record(
    token: string,
    fields: { amount: number; splitBetween: string[] },
    using: Application = app,
  ): Promise<string> {
    const answer = await call(using, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Expense', date: PAST_DAY, ...fields },
      token,
    });
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  const balances = (token = adaToken, using: Application = app) =>
    call(using, 'GET', `/groups/${groupId}/balances`, { token });

  /** The balances answered, as a map from member to balance. */
  const asMap = (rows: { memberId: string; balance: number }[]) =>
    Object.fromEntries(rows.map(row => [row.memberId, row.balance]));

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    ({ id: adaId, token: adaToken } = await accountOf(ada));
    ({ id: graceId, token: graceToken } = await accountOf(grace));
    ({ id: linusId, token: linusToken } = await accountOf(linus));
    groupId = (await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' }, token: adaToken }))
      .body.id;
    await join(graceToken);
    await join(linusToken);
  });

  afterEach(async () => {
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    await database.remove();
  });

  describe('reading the balances', () => {
    it('answers every member with a balance of 0 when nothing is recorded, the owner first, then the others in the order they joined', async () => {
      expect(await balances()).toEqual({
        status: 200,
        body: [
          { memberId: adaId, balance: 0 },
          { memberId: graceId, balance: 0 },
          { memberId: linusId, balance: 0 },
        ],
      });
    });

    it('answers the members in the order they joined, the earliest first, whatever their names', async () => {
      const otherGroup = (
        await call(app, 'POST', '/groups', { body: { name: 'Second', currency: 'USD' }, token: adaToken })
      ).body.id;
      // Linus joins this group before Grace: the order is the order of joining.
      const joinOther = async (token: string) => {
        const invitation = await call(app, 'POST', `/groups/${otherGroup}/invitations`, { token: adaToken });
        return call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token });
      };
      await joinOther(linusToken);
      await joinOther(graceToken);
      const answer = await call(app, 'GET', `/groups/${otherGroup}/balances`, { token: adaToken });
      expect(answer.body.map((row: { memberId: string }) => row.memberId)).toEqual([adaId, linusId, graceId]);
    });

    it('answers the payer what they paid minus their share, and the others minus their shares', async () => {
      await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
      // Equal split of 1000 among three: Ada's share is 334 (the remainder), Grace's and Linus's 333.
      expect((await balances()).body).toEqual([
        { memberId: adaId, balance: 666 },
        { memberId: graceId, balance: -333 },
        { memberId: linusId, balance: -333 },
      ]);
    });

    it('answers 0 for a member who is even, and for a member outside every split who recorded nothing', async () => {
      await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId] });
      expect(asMap((await balances()).body)).toEqual({ [adaId]: 500, [graceId]: -500, [linusId]: 0 });
    });

    it('counts every expense of the group: what a member paid, and what they have in each share', async () => {
      await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
      await record(graceToken, { amount: 600, splitBetween: [adaId, graceId, linusId] });
      await record(graceToken, { amount: 100, splitBetween: [graceId, linusId] });
      // Ada: paid 1000, shares 334 + 200. Grace: paid 700, shares 333 + 200 + 50. Linus: shares 333 + 200 + 50.
      expect(asMap((await balances()).body)).toEqual({
        [adaId]: 1000 - 334 - 200,
        [graceId]: 700 - 333 - 200 - 50,
        [linusId]: -(333 + 200 + 50),
      });
    });

    it('leaves out the expenses of other groups', async () => {
      const otherGroup = (
        await call(app, 'POST', '/groups', { body: { name: 'Elsewhere', currency: 'GBP' }, token: adaToken })
      ).body.id;
      await call(app, 'POST', `/groups/${otherGroup}/expenses`, {
        body: { description: 'Elsewhere', amount: 5000, date: PAST_DAY, splitBetween: [adaId] },
        token: adaToken,
      });
      expect((await balances()).body.every((row: { balance: number }) => row.balance === 0)).toBe(true);
    });

    it('lets every member of the group read the balances, and they answer the same', async () => {
      await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
      const fromOwner = (await balances(adaToken)).body;
      expect((await balances(graceToken)).body).toEqual(fromOwner);
      expect((await balances(linusToken)).body).toEqual(fromOwner);
    });

    it('answers 404 to an account outside the group, as if the group did not exist', async () => {
      const outsider = await accountOf(outsiderAccount);
      const notMember = await balances(outsider.token);
      const missing = await call(app, 'GET', '/groups/no-such-group/balances', { token: outsider.token });
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      expect((await call(app, 'GET', `/groups/${groupId}/balances`)).status).toBe(401);
      expect((await balances('made-up-token')).status).toBe(401);
    });

    it('changes nothing that is stored: reading the balances leaves the rows of the database as they were', async () => {
      await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId, linusId] });
      const counts = async () => {
        const counted: number[] = [];
        for (const table of ['expenses', 'expense_shares', 'group_members', 'accounts', 'groups'])
          counted.push(await countRows(database.url, table));
        return counted;
      };
      const before = await counts();
      const first = (await balances()).body;
      expect((await balances()).body).toEqual(first);
      expect(await counts()).toEqual(before);
    });
  });

  describe('the zero sum', () => {
    it('adds up to 0 exactly after expenses of odd amounts, paid and split in every way', async () => {
      const tokens = [adaToken, graceToken, linusToken];
      const ids = [adaId, graceId, linusId];
      for (let index = 0; index < 30; index++) {
        const payer = index % 3;
        const splitBetween =
          index % 3 === 0 ? [...ids] : index % 3 === 1 ? [ids[payer], ids[(payer + 1) % 3]] : [ids[payer]];
        await record(tokens[payer], { amount: 1 + ((index * 7919) % 99_991), splitBetween });
      }
      const rows = (await balances()).body as { balance: number }[];
      expect(rows.reduce((sum, row) => sum + row.balance, 0)).toBe(0);
    });

    it('stays at 0 when several servers on the same database record expenses at the same time, each counted once', async () => {
      const second = await startApplication(database.url);
      const third = await startApplication(database.url);
      extraApps.push(second, third);
      const servers = [app, second, third];
      const tokens = [adaToken, graceToken, linusToken];
      const ids = [adaId, graceId, linusId];

      const requests = Array.from({ length: 45 }, (_, index) => {
        const payer = index % 3;
        const splitBetween =
          index % 2 === 0 ? [...ids] : [ids[payer], ids[(payer + 1 + (index % 4 === 1 ? 1 : 0)) % 3]];
        return call(servers[index % 3], 'POST', `/groups/${groupId}/expenses`, {
          body: {
            description: `Expense ${index}`,
            amount: 1 + ((index * 104_729) % 100_000),
            date: PAST_DAY,
            splitBetween,
          },
          token: tokens[payer],
        });
      });
      const answers = await Promise.all(requests);
      expect(answers.every(answer => answer.status === 201)).toBe(true);
      const expenseIds = answers.map(answer => answer.body.id as string);
      expect(new Set(expenseIds).size).toBe(45);

      // What each expense says, read from a server that did not necessarily record it.
      const expected: Record<string, number> = { [adaId]: 0, [graceId]: 0, [linusId]: 0 };
      for (const id of expenseIds) {
        const expense = (await call(third, 'GET', `/expenses/${id}`, { token: adaToken })).body;
        expected[expense.paidBy] += expense.amount;
        for (const share of expense.shares) expected[share.memberId] -= share.amount;
      }
      expect(Object.values(expected).reduce((sum, value) => sum + value, 0)).toBe(0);

      for (const server of servers) {
        const answer = await balances(adaToken, server);
        expect(answer.status).toBe(200);
        expect(asMap(answer.body)).toEqual(expected);
        expect(answer.body.reduce((sum: number, row: { balance: number }) => sum + row.balance, 0)).toBe(0);
      }
    });
  });
});
