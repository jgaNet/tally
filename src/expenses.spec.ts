import { Application } from './app';
import { equalShares, todayUtc } from './expenses';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };
const linus = { email: 'linus@example.com', password: 'kernel-1991', name: 'Linus Torvalds' };

const DAY_MS = 24 * 60 * 60 * 1000;
const tomorrowUtc = () => new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);

describe('expenses', () => {
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

  /** Brings the account into the group by an invitation of a member. */
  async function join(accountToken: string, inviterToken = adaToken): Promise<void> {
    const invitation = await call(app, 'POST', `/groups/${groupId}/invitations`, { token: inviterToken });
    const answer = await call(app, 'POST', `/invitations/${invitation.body.id}/accept`, { token: accountToken });
    expect(answer.status).toBe(204);
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
    description: 'Groceries',
    amount: 1000,
    date: '2026-11-01',
    splitBetween: [adaId, graceId, linusId],
    ...fields,
  });

  const record = (fields: Record<string, unknown> = {}, token = adaToken, to = groupId) =>
    call(app, 'POST', `/groups/${to}/expenses`, { body: expense(fields), token });

  /** Records an expense and answers its id. */
  async function recordedExpense(fields: Record<string, unknown> = {}, token = adaToken): Promise<string> {
    const answer = await record(fields, token);
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  const refusal = (type: string) => ({ status: 422, body: { type, message: expect.any(String) } });

  describe('the equal split', () => {
    it('gives 1000 split between three members to the two others 333 each and to the payer 334', () => {
      expect(equalShares(1000, [graceId, linusId, adaId], adaId)).toEqual([
        { memberId: graceId, amount: 333 },
        { memberId: linusId, amount: 333 },
        { memberId: adaId, amount: 334 },
      ]);
    });

    it('gives the remainder to the payer wherever the payer stands in the split', () => {
      expect(equalShares(1000, [adaId, graceId, linusId], adaId)).toEqual([
        { memberId: adaId, amount: 334 },
        { memberId: graceId, amount: 333 },
        { memberId: linusId, amount: 333 },
      ]);
    });

    it('gives the whole amount to a payer who is alone in the split', () => {
      expect(equalShares(99_999_999, [adaId], adaId)).toEqual([{ memberId: adaId, amount: 99_999_999 }]);
    });

    it.each([
      [1, 3],
      [2, 3],
      [7, 2],
      [1000, 3],
      [100_000_000, 3],
      [100_000_000, 7],
      [99_999_999, 6],
    ])('never loses a unit: %i split between %i members adds up exactly to the amount', (amount, members) => {
      const split = Array.from({ length: members }, (_, index) => `member-${index}`);
      const shares = equalShares(amount, split, split[members - 1]);
      expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(amount);
      for (const share of shares) {
        expect(share.amount).toBeGreaterThanOrEqual(Math.floor(amount / members));
        expect(share.amount - Math.floor(amount / members)).toBeLessThan(members);
      }
    });
  });

  describe('recording an expense', () => {
    it('answers the id of the new expense', async () => {
      const answer = await record();
      expect(answer.status).toBe(201);
      expect(typeof answer.body.id).toBe('string');
    });

    it('records the expense with the payer as the member who recorded it', async () => {
      const id = await recordedExpense({}, graceToken);
      expect((await call(app, 'GET', `/expenses/${id}`, { token: graceToken })).body.paidBy).toBe(graceId);
    });

    it('keeps the description without the spaces around it', async () => {
      const id = await recordedExpense({ description: '  Groceries  ' });
      expect((await call(app, 'GET', `/expenses/${id}`, { token: adaToken })).body.description).toBe('Groceries');
    });

    it('accepts a description of exactly 1 character, and of exactly 100, counting characters', async () => {
      expect((await record({ description: 'x' })).status).toBe(201);
      expect((await record({ description: 'x'.repeat(100) })).status).toBe(201);
      expect((await record({ description: '😀'.repeat(100) })).status).toBe(201);
    });

    it.each([
      ['an empty description', ''],
      ['a description of only spaces', '   '],
      ['a description of 101 characters', 'x'.repeat(101)],
      ['a description of 101 emoji', '😀'.repeat(101)],
    ])('refuses %s', async (_, description) => {
      expect(await record({ description })).toEqual(refusal('InvalidDescription'));
    });

    it('accepts an amount of exactly 1 and of exactly 100 000 000', async () => {
      expect((await record({ amount: 1 })).status).toBe(201);
      expect((await record({ amount: 100_000_000 })).status).toBe(201);
    });

    it.each([0, -5, 100_000_001])('refuses the amount %i, which is outside 1 to 100 000 000', async amount => {
      expect(await record({ amount })).toEqual(refusal('InvalidAmount'));
    });

    it('refuses an amount that is not a whole number, or not a number, with 400', async () => {
      expect((await record({ amount: 10.5 })).status).toBe(400);
      expect((await record({ amount: '1000' })).status).toBe(400);
    });

    it('accepts today in UTC, and a leap day', async () => {
      expect((await record({ date: todayUtc() })).status).toBe(201);
      expect((await record({ date: '2024-02-29' })).status).toBe(201);
    });

    it.each(['2026-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-1-05', '17/11/2026', 'yesterday'])(
      'refuses the date %j, which is not a day of the calendar',
      async date => {
        expect(await record({ date })).toEqual(refusal('InvalidDate'));
      },
    );

    it('refuses a date after today in UTC', async () => {
      expect(await record({ date: tomorrowUtc() })).toEqual(refusal('FutureDate'));
    });

    it('refuses a body without one of its fields with 400', async () => {
      for (const field of ['description', 'amount', 'date', 'splitBetween']) {
        const body: Record<string, unknown> = expense();
        delete body[field];
        expect((await call(app, 'POST', `/groups/${groupId}/expenses`, { body, token: adaToken })).status).toBe(400);
      }
    });

    it('refuses a split that is not a list of account ids with 400', async () => {
      expect((await record({ splitBetween: adaId })).status).toBe(400);
      expect((await record({ splitBetween: [adaId, 7] })).status).toBe(400);
    });

    it('accepts a split of the payer alone, and one that leaves out the other members', async () => {
      expect((await record({ splitBetween: [adaId] })).status).toBe(201);
      expect((await record({ splitBetween: [adaId, graceId] })).status).toBe(201);
    });

    it('refuses a split that does not name the payer', async () => {
      expect(await record({ splitBetween: [graceId, linusId] })).toEqual(refusal('InvalidSplit'));
      expect(await record({ splitBetween: [] })).toEqual(refusal('InvalidSplit'));
    });

    it('refuses a split that names a member twice', async () => {
      expect(await record({ splitBetween: [adaId, graceId, graceId] })).toEqual(refusal('InvalidSplit'));
    });

    it('refuses a split that names an account which is not a member of the group', async () => {
      const outsider = await accountOf({ email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' });
      expect(await record({ splitBetween: [adaId, outsider.id] })).toEqual(refusal('InvalidSplit'));
    });

    it('keeps the split in the order the recording member gave it', async () => {
      const id = await recordedExpense({ splitBetween: [linusId, adaId, graceId] }, adaToken);
      const answer = await call(app, 'GET', `/expenses/${id}`, { token: adaToken });
      expect(answer.body.shares.map((share: { memberId: string }) => share.memberId)).toEqual([
        linusId,
        adaId,
        graceId,
      ]);
    });

    it('refuses a request without a token with 401, and one with a token that proves nothing', async () => {
      expect((await call(app, 'POST', `/groups/${groupId}/expenses`, { body: expense() })).status).toBe(401);
      expect((await record({}, 'made-up-token')).status).toBe(401);
    });

    it('refuses an expense in a group the account is not in, as if the group did not exist', async () => {
      const outsider = await accountOf({ email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' });
      const notMember = await record({}, outsider.token);
      const missing = await record({}, adaToken, 'no-such-group');
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });
  });

  describe('reading an expense', () => {
    it('answers the expense with its description, amount, date, payer and each share, in the order of the split', async () => {
      const id = await recordedExpense({ description: 'Groceries', amount: 1000, date: '2026-11-01' });
      expect(await call(app, 'GET', `/expenses/${id}`, { token: adaToken })).toEqual({
        status: 200,
        body: {
          id,
          groupId,
          description: 'Groceries',
          amount: 1000,
          date: '2026-11-01',
          paidBy: adaId,
          shares: [
            { memberId: adaId, amount: 334 },
            { memberId: graceId, amount: 333 },
            { memberId: linusId, amount: 333 },
          ],
        },
      });
    });

    it('lets every member of the group read the expense', async () => {
      const id = await recordedExpense();
      for (const token of [adaToken, graceToken, linusToken]) {
        expect((await call(app, 'GET', `/expenses/${id}`, { token })).status).toBe(200);
      }
    });

    it('does not show an expense to an account outside its group, as if it did not exist', async () => {
      const id = await recordedExpense();
      const outsider = await accountOf({ email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' });
      const notMember = await call(app, 'GET', `/expenses/${id}`, { token: outsider.token });
      const missing = await call(app, 'GET', '/expenses/no-such-expense', { token: outsider.token });
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 401 without a token, whether or not the expense exists', async () => {
      const id = await recordedExpense();
      expect((await call(app, 'GET', `/expenses/${id}`)).status).toBe(401);
      expect((await call(app, 'GET', '/expenses/no-such-expense')).status).toBe(401);
    });

    it('answers the shares of a split that does not include the other members', async () => {
      const id = await recordedExpense({ amount: 10, splitBetween: [graceId, adaId] });
      expect((await call(app, 'GET', `/expenses/${id}`, { token: adaToken })).body.shares).toEqual([
        { memberId: graceId, amount: 5 },
        { memberId: adaId, amount: 5 },
      ]);
    });
  });
});
