import { DatabaseSync } from 'node:sqlite';
import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };
const outsiderAccount = { email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' };

const PAST_DAY = '2026-11-01';
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

describe('settling up in cash', () => {
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
  async function record(token: string, fields: Record<string, unknown>): Promise<void> {
    const answer = await call(app, 'POST', `/groups/${groupId}/expenses`, {
      body: { description: 'Expense', date: PAST_DAY, ...fields },
      token,
    });
    expect(answer.status).toBe(201);
  }

  /** Records a cash settlement of the group, by the account that signs the request with `token`. */
  const settle = (body: unknown, token: string, using: Application = app) =>
    call(using, 'POST', `/groups/${groupId}/settlements/cash`, { body, token });

  const balancesOf = async (token = adaToken, using: Application = app): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await call(using, 'GET', `/groups/${groupId}/balances`, { token })).body.map(
        (row: { memberId: string; balance: number }) => [row.memberId, row.balance],
      ),
    );

  const countSettlements = (): number => {
    const probe = new DatabaseSync(database.path);
    try {
      return (probe.prepare('SELECT COUNT(*) AS n FROM settlements').get() as { n: number }).n;
    } finally {
      probe.close();
    }
  };

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
    for (const extra of extraApps.splice(0)) await extra.stop();
    await app.stop();
    database.remove();
  });

  /**
   * Ada paid 1000 for herself and Grace: Grace owes Ada 500. Then Linus owes Ada nothing.
   * Balances: Ada 500, Grace -500, Linus 0.
   */
  async function oneExpenseBetweenAdaAndGrace(): Promise<void> {
    await record(adaToken, { amount: 1000, splitBetween: [adaId, graceId] });
  }

  describe('recording a settlement', () => {
    it('records the payer paying the payee in cash, and answers the id of the settlement', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const answer = await settle({ from: graceId, amount: 300 }, adaToken);
      expect(answer).toEqual({ status: 201, body: { id: expect.any(String) } });
    });

    it('counts it at once: the payer’s balance goes up by its amount, the payee’s goes down, and they add up to 0', async () => {
      await oneExpenseBetweenAdaAndGrace();
      expect(await balancesOf()).toEqual({ [adaId]: 500, [graceId]: -500, [linusId]: 0 });
      await settle({ from: graceId, amount: 300 }, adaToken);
      const balances = await balancesOf();
      expect(balances).toEqual({ [adaId]: 200, [graceId]: -200, [linusId]: 0 });
      expect(Object.values(balances).reduce((sum, balance) => sum + balance, 0)).toBe(0);
    });

    it('lets the payer settle what they owe in full, leaving them even', async () => {
      await oneExpenseBetweenAdaAndGrace();
      expect((await settle({ from: graceId, amount: 500 }, adaToken)).status).toBe(201);
      expect(await balancesOf()).toEqual({ [adaId]: 0, [graceId]: 0, [linusId]: 0 });
    });

    it('refuses a settlement recorded the wrong way round, from the one who is owed to the one who owes', async () => {
      await oneExpenseBetweenAdaAndGrace();
      // Grace is the one who owes: Grace cannot record a payment from Ada to Grace.
      const answer = await settle({ from: adaId, amount: 100 }, graceToken);
      expect(answer.status).toBe(409);
      expect(await balancesOf()).toEqual({ [adaId]: 500, [graceId]: -500, [linusId]: 0 });
    });

    it('lets both the payer and the payee read the settlement', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const id = (await settle({ from: graceId, amount: 100 }, adaToken)).body.id;
      expect((await call(app, 'GET', `/settlements/${id}`, { token: adaToken })).status).toBe(200);
      expect((await call(app, 'GET', `/settlements/${id}`, { token: graceToken })).status).toBe(200);
    });
  });

  describe('never more than is owed', () => {
    it('refuses more than the payer owes the group, and changes nothing', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const answer = await settle({ from: graceId, amount: 501 }, adaToken);
      expect(answer).toEqual({ status: 409, body: { type: 'AmountTooLarge', message: expect.any(String) } });
      expect(await balancesOf()).toEqual({ [adaId]: 500, [graceId]: -500, [linusId]: 0 });
      expect(countSettlements()).toBe(0);
    });

    it('refuses more than the payee is owed by the group, and changes nothing', async () => {
      // Ada paid 600 for herself (100) and Linus (500): Ada is owed 100 by the group, Linus owes 100.
      await record(adaToken, {
        amount: 600,
        splitExactly: [
          { memberId: adaId, amount: 500 },
          { memberId: linusId, amount: 100 },
        ],
      });
      // Grace paid 500 for Linus: Grace is owed 500, Linus owes 500 more: Linus owes 600 in all.
      await record(graceToken, {
        amount: 500,
        splitExactly: [
          { memberId: graceId, amount: 0 },
          { memberId: linusId, amount: 500 },
        ],
      });
      expect(await balancesOf()).toEqual({ [adaId]: 100, [graceId]: 500, [linusId]: -600 });

      // Linus owes 600, which is enough; Ada is owed only 100, so 200 is refused.
      const answer = await settle({ from: linusId, amount: 200 }, adaToken);
      expect(answer.status).toBe(409);
      expect(await balancesOf()).toEqual({ [adaId]: 100, [graceId]: 500, [linusId]: -600 });
      expect(countSettlements()).toBe(0);

      // The amount Ada is owed is accepted.
      expect((await settle({ from: linusId, amount: 100 }, adaToken)).status).toBe(201);
    });

    it('refuses a settlement from a payer who owes nothing, whatever the amount', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const answer = await settle({ from: linusId, amount: 1 }, adaToken);
      expect(answer.status).toBe(409);
      expect(countSettlements()).toBe(0);
    });

    it('refuses an amount that is not a whole number of at least 1, and changes nothing', async () => {
      await oneExpenseBetweenAdaAndGrace();
      expect(await settle({ from: graceId, amount: 0 }, adaToken)).toEqual({
        status: 422,
        body: { type: 'InvalidAmount', message: expect.any(String) },
      });
      expect(await settle({ from: graceId, amount: -5 }, adaToken)).toEqual({
        status: 422,
        body: { type: 'InvalidAmount', message: expect.any(String) },
      });
      expect((await settle({ from: graceId, amount: 1.5 }, adaToken)).status).toBe(400);
      expect((await settle({ from: graceId, amount: '100' }, adaToken)).status).toBe(400);
      expect(await balancesOf()).toEqual({ [adaId]: 500, [graceId]: -500, [linusId]: 0 });
      expect(countSettlements()).toBe(0);
    });

    it('refuses a payer who is the payee, or who is not a member of the group, and changes nothing', async () => {
      await oneExpenseBetweenAdaAndGrace();
      expect(await settle({ from: adaId, amount: 100 }, adaToken)).toEqual({
        status: 422,
        body: { type: 'InvalidPayer', message: expect.any(String) },
      });
      const outsider = await accountOf(outsiderAccount);
      expect(await settle({ from: outsider.id, amount: 100 }, adaToken)).toEqual({
        status: 422,
        body: { type: 'InvalidPayer', message: expect.any(String) },
      });
      expect(countSettlements()).toBe(0);
    });

    it('refuses a payer who has left the group, as no longer a member', async () => {
      // Ada paid 300 for herself and Linus: Linus owes 150. Linus settles it, is even, and leaves.
      await record(adaToken, { amount: 300, splitBetween: [adaId, linusId] });
      expect((await settle({ from: linusId, amount: 150 }, adaToken)).status).toBe(201);
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: linusToken })).status).toBe(204);
      const answer = await settle({ from: linusId, amount: 1 }, adaToken);
      expect(answer).toEqual({ status: 422, body: { type: 'InvalidPayer', message: expect.any(String) } });
    });

    it('answers 404 for an account outside the group, and for a group that does not exist', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const outsider = await accountOf(outsiderAccount);
      const notMember = await settle({ from: graceId, amount: 100 }, outsider.token);
      const missing = await call(app, 'POST', '/groups/no-such-group/settlements/cash', {
        body: { from: graceId, amount: 100 },
        token: outsider.token,
      });
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 401 without a token, and for a token that proves nothing', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const body = { from: graceId, amount: 100 };
      expect((await call(app, 'POST', `/groups/${groupId}/settlements/cash`, { body })).status).toBe(401);
      expect((await settle(body, 'made-up-token')).status).toBe(401);
    });

    it('decides two settlements recorded at once on the balances as the other left them', async () => {
      await oneExpenseBetweenAdaAndGrace();
      // Two servers on the same database file: each would pay 300 of Grace's 500, which together is too much.
      const second = await startApplication(database.path);
      extraApps.push(second);
      const answers = await Promise.all([
        settle({ from: graceId, amount: 300 }, adaToken, app),
        settle({ from: graceId, amount: 300 }, adaToken, second),
      ]);
      expect(answers.map(answer => answer.status).sort()).toEqual([201, 409]);
      expect(await balancesOf()).toEqual({ [adaId]: 200, [graceId]: -200, [linusId]: 0 });
      expect(countSettlements()).toBe(1);
    });
  });

  describe('reading a settlement', () => {
    it('answers the settlement, to a member of the group, as the request says it', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const id = (await settle({ from: graceId, amount: 300 }, adaToken)).body.id;
      const answer = await call(app, 'GET', `/settlements/${id}`, { token: graceToken });
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({
        id,
        groupId,
        from: graceId,
        to: adaId,
        amount: 300,
        method: 'cash',
        status: 'paid',
        at: expect.stringMatching(AT_PATTERN),
        history: [{ status: 'paid', at: expect.stringMatching(AT_PATTERN) }],
      });
    });

    it('answers when it was recorded, as a moment of the time it was recorded', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const before = Date.now();
      const id = (await settle({ from: graceId, amount: 300 }, adaToken)).body.id;
      const at = (await call(app, 'GET', `/settlements/${id}`, { token: adaToken })).body.at;
      expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(at)).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('answers 404 to an account outside the group, and for a settlement that does not exist', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const id = (await settle({ from: graceId, amount: 300 }, adaToken)).body.id;
      const outsider = await accountOf(outsiderAccount);
      const notMember = await call(app, 'GET', `/settlements/${id}`, { token: outsider.token });
      const missing = await call(app, 'GET', '/settlements/no-such-settlement', { token: adaToken });
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 401 without a token', async () => {
      await oneExpenseBetweenAdaAndGrace();
      const id = (await settle({ from: graceId, amount: 300 }, adaToken)).body.id;
      expect((await call(app, 'GET', `/settlements/${id}`)).status).toBe(401);
    });

    it('answers the settlement of a member who has left the group, to the members who remain', async () => {
      await record(adaToken, { amount: 300, splitBetween: [adaId, linusId] });
      const id = (await settle({ from: linusId, amount: 150 }, adaToken)).body.id;
      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: linusToken })).status).toBe(204);
      expect((await call(app, 'GET', `/settlements/${id}`, { token: adaToken })).body).toMatchObject({
        from: linusId,
        to: adaId,
        amount: 150,
      });
    });
  });

  describe('what reads a balance counts', () => {
    it('counts the settlement in the suggested settlements', async () => {
      await oneExpenseBetweenAdaAndGrace();
      await settle({ from: graceId, amount: 300 }, adaToken);
      expect((await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken })).body).toEqual([
        { from: graceId, to: adaId, amount: 200 },
      ]);
    });

    it('suggests no settlement once the settlements bring every balance to 0', async () => {
      await oneExpenseBetweenAdaAndGrace();
      await settle({ from: graceId, amount: 500 }, adaToken);
      expect((await call(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token: adaToken })).body).toEqual(
        [],
      );
    });

    it('lets a member leave at once, whatever they still owe, and the owner takes over what is left', async () => {
      await oneExpenseBetweenAdaAndGrace();
      await settle({ from: graceId, amount: 300 }, adaToken);
      expect(await balancesOf()).toEqual({ [adaId]: 200, [graceId]: -200, [linusId]: 0 });

      expect((await call(app, 'POST', `/groups/${groupId}/leave`, { token: graceToken })).status).toBe(204);
      expect(await balancesOf()).toEqual({ [adaId]: 0, [linusId]: 0 });
    });

    it("lists a cash settlement in a member's statement, after the expense, and its balance is the balances' one", async () => {
      await oneExpenseBetweenAdaAndGrace();
      await settle({ from: graceId, amount: 300 }, adaToken);
      const statement = (
        await call(app, 'GET', `/groups/${groupId}/members/${graceId}/statement`, { token: graceToken })
      ).body;
      expect(statement.balance).toBe(-200);
      expect(statement.entries).toEqual([
        expect.objectContaining({ kind: 'expense', paid: 0, share: 500, balance: -500 }),
        expect.objectContaining({
          kind: 'settlement',
          description: 'Settlement in cash',
          paid: 300,
          share: 0,
          balance: -200,
        }),
      ]);
      expect((await balancesOf(graceToken, app))[graceId]).toBe(-200);
    });

    it('answers the same balances to every member of the group, settlements included', async () => {
      await oneExpenseBetweenAdaAndGrace();
      await settle({ from: graceId, amount: 300 }, adaToken);
      const fromAda = await balancesOf(adaToken);
      expect(await balancesOf(graceToken)).toEqual(fromAda);
      expect(await balancesOf(linusToken)).toEqual(fromAda);
    });
  });
});
