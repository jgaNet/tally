import { Application } from './app';
import { equalShares, sharesByWeight, todayUtc } from './expenses';
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

  /** The expense split by the amounts given, in place of the equal split of the default expense. */
  const byAmounts = (splitExactly: unknown[], fields: Record<string, unknown> = {}) => ({
    splitBetween: undefined,
    splitExactly,
    ...fields,
  });

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
          splitKind: 'equal',
          version: 1,
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

  describe('the version of an expense', () => {
    it('is 1 when the expense is recorded, and the read answers it as an integer', async () => {
      const id = await recordedExpense();
      expect((await call(app, 'GET', `/expenses/${id}`, { token: adaToken })).body.version).toBe(1);
    });
  });

  // An edit sends the expense whole, from the version its author read.
  const edit = (fields: Record<string, unknown> = {}) => ({
    description: 'Groceries',
    amount: 1000,
    date: '2026-11-01',
    splitBetween: [adaId, graceId, linusId],
    version: 1,
    ...fields,
  });

  const change = (id: string, fields: Record<string, unknown> = {}, token = adaToken) =>
    call(app, 'PUT', `/expenses/${id}`, { body: edit(fields), token });

  const readExpense = async (id: string, token = adaToken) =>
    (await call(app, 'GET', `/expenses/${id}`, { token })).body;

  const balancesOf = async (token = adaToken) =>
    (await call(app, 'GET', `/groups/${groupId}/balances`, { token })).body;

  const remove = (id: string, token = adaToken) => call(app, 'DELETE', `/expenses/${id}`, { token });

  const notFound = { status: 404, body: { type: 'NotFound', message: expect.any(String) } };

  describe('editing an expense', () => {
    it('replaces the description, amount, date and split, computes the shares again, and adds one version', async () => {
      const id = await recordedExpense();
      const answer = await change(id, {
        description: 'Dinner',
        amount: 900,
        date: '2026-10-30',
        splitBetween: [adaId, graceId],
      });
      expect(answer).toEqual({ status: 204, body: undefined });
      expect(await readExpense(id)).toEqual({
        id,
        groupId,
        description: 'Dinner',
        amount: 900,
        date: '2026-10-30',
        paidBy: adaId,
        shares: [
          { memberId: adaId, amount: 450 },
          { memberId: graceId, amount: 450 },
        ],
        splitKind: 'equal',
        version: 2,
      });
    });

    it('gives one more version at each edit, each made from the version before it', async () => {
      const id = await recordedExpense();
      expect((await change(id, { description: 'First' })).status).toBe(204);
      expect((await change(id, { description: 'Second', version: 2 })).status).toBe(204);
      expect(await readExpense(id)).toMatchObject({ description: 'Second', version: 3 });
    });

    it('keeps the payer as the one who paid when the owner edits an expense of another member', async () => {
      const id = await recordedExpense({}, graceToken);
      expect((await change(id, { description: 'Edited by the owner' }, adaToken)).status).toBe(204);
      expect(await readExpense(id, graceToken)).toMatchObject({ paidBy: graceId, description: 'Edited by the owner' });
    });

    it('lets the payer edit their own expense', async () => {
      const id = await recordedExpense({}, graceToken);
      expect((await change(id, { description: 'Edited by the payer' }, graceToken)).status).toBe(204);
      expect(await readExpense(id, graceToken)).toMatchObject({ paidBy: graceId, description: 'Edited by the payer' });
    });

    it('refuses an edit that leaves the payer out of the split, even when the owner makes it', async () => {
      const id = await recordedExpense({}, graceToken);
      expect(await change(id, { splitBetween: [adaId, linusId] }, adaToken)).toEqual(refusal('InvalidSplit'));
      expect(await readExpense(id, graceToken)).toMatchObject({ version: 1, shares: expect.any(Array) });
    });

    it('refuses an edit by another member of the group with 403, and keeps nothing of it', async () => {
      const id = await recordedExpense({}, graceToken);
      const answer = await change(id, { description: 'Not for linus to change' }, linusToken);
      expect(answer).toEqual({ status: 403, body: { type: 'NotAllowed', message: expect.any(String) } });
      expect(await readExpense(id)).toMatchObject({ description: 'Groceries', version: 1 });
    });

    it('refuses an edit by an account outside the group as if the expense did not exist', async () => {
      const id = await recordedExpense();
      const outsider = await accountOf({ email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' });
      const notMember = await change(id, {}, outsider.token);
      const missing = await change('no-such-expense', {}, outsider.token);
      expect(notMember).toEqual(notFound);
      expect(missing).toEqual(notMember);
    });

    it('refuses an edit made from a version that is no longer the current one, and keeps nothing of it', async () => {
      const id = await recordedExpense();
      expect((await change(id, { description: 'First' })).status).toBe(204);
      expect(await change(id, { description: 'Stale', version: 1 })).toEqual({
        status: 409,
        body: { type: 'ExpenseChanged', message: expect.any(String) },
      });
      expect(await readExpense(id)).toMatchObject({ description: 'First', version: 2 });
    });

    it.each([
      ['a zero amount', { amount: 0 }, 'InvalidAmount'],
      ['an amount above the maximum', { amount: 100_000_001 }, 'InvalidAmount'],
      ['a description of only spaces', { description: '   ' }, 'InvalidDescription'],
      ['a date that is not a day', { date: '2026-02-29' }, 'InvalidDate'],
      ['a date after today', { date: tomorrowUtc() }, 'FutureDate'],
    ])('refuses %s with the rule of recording it, and keeps nothing', async (_, fields, type) => {
      const id = await recordedExpense();
      expect(await change(id, fields)).toEqual(refusal(type));
      expect(await readExpense(id)).toMatchObject({ amount: 1000, description: 'Groceries', version: 1 });
    });

    it('refuses a split that names a member twice with the rule of recording it, and keeps nothing', async () => {
      const id = await recordedExpense();
      expect(await change(id, { splitBetween: [adaId, graceId, graceId] })).toEqual(refusal('InvalidSplit'));
      expect(await readExpense(id)).toMatchObject({ version: 1 });
    });

    it('refuses a split that names an account which is not a member of the group', async () => {
      const id = await recordedExpense();
      const outsider = await accountOf({ email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' });
      expect(await change(id, { splitBetween: [adaId, outsider.id] })).toEqual(refusal('InvalidSplit'));
    });

    it('refuses a body without its version, or with a version that is not a whole number from 1, with 400', async () => {
      const id = await recordedExpense();
      const body: Record<string, unknown> = edit();
      delete body.version;
      expect((await call(app, 'PUT', `/expenses/${id}`, { body, token: adaToken })).status).toBe(400);
      for (const version of [0, 1.5, '1']) {
        expect((await change(id, { version })).status).toBe(400);
      }
      expect(await readExpense(id)).toMatchObject({ version: 1 });
    });

    it('refuses a request without a token with 401', async () => {
      const id = await recordedExpense();
      expect((await call(app, 'PUT', `/expenses/${id}`, { body: edit() })).status).toBe(401);
    });

    it('keeps exactly one of two edits made at once from the same version, on the same server', async () => {
      const id = await recordedExpense();
      const [first, second] = await Promise.all([
        change(id, { description: 'Edit one' }),
        change(id, { description: 'Edit two' }),
      ]);
      expect([first.status, second.status].sort()).toEqual([204, 409]);
      const kept = first.status === 204 ? 'Edit one' : 'Edit two';
      expect(await readExpense(id)).toMatchObject({ description: kept, version: 2 });
    });

    it('keeps exactly one of two edits made at once from the same version, through two servers on one database', async () => {
      const id = await recordedExpense();
      const other = await startApplication(database.path);
      try {
        const [first, second] = await Promise.all([
          call(app, 'PUT', `/expenses/${id}`, { body: edit({ splitBetween: [adaId, graceId] }), token: adaToken }),
          call(other, 'PUT', `/expenses/${id}`, { body: edit({ splitBetween: [adaId, linusId] }), token: adaToken }),
        ]);
        expect([first.status, second.status].sort()).toEqual([204, 409]);
        const kept = first.status === 204 ? [adaId, graceId] : [adaId, linusId];
        const expense = await readExpense(id);
        expect(expense).toMatchObject({ version: 2 });
        expect(expense.shares.map((share: { memberId: string }) => share.memberId)).toEqual(kept);
        const balances = await balancesOf();
        expect(balances.reduce((sum: number, member: { balance: number }) => sum + member.balance, 0)).toBe(0);
      } finally {
        await other.stop();
      }
    });
  });

  describe('deleting an expense', () => {
    it('deletes the expense, which is then not read by anyone, and answers 204', async () => {
      const id = await recordedExpense();
      expect(await remove(id)).toEqual({ status: 204, body: undefined });
      expect(await call(app, 'GET', `/expenses/${id}`, { token: adaToken })).toEqual(notFound);
    });

    it('takes the expense out of every balance', async () => {
      const id = await recordedExpense({ amount: 999 });
      expect((await balancesOf()).map((member: { balance: number }) => member.balance)).not.toEqual([0, 0, 0]);
      await remove(id);
      expect(await balancesOf()).toEqual([
        { memberId: adaId, balance: 0 },
        { memberId: graceId, balance: 0 },
        { memberId: linusId, balance: 0 },
      ]);
    });

    it('lets the payer delete their own expense', async () => {
      const id = await recordedExpense({}, graceToken);
      expect((await remove(id, graceToken)).status).toBe(204);
    });

    it('lets the owner delete an expense of another member', async () => {
      const id = await recordedExpense({}, graceToken);
      expect((await remove(id, adaToken)).status).toBe(204);
    });

    it('refuses a delete by another member with 403, and keeps the expense', async () => {
      const id = await recordedExpense({}, graceToken);
      expect(await remove(id, linusToken)).toEqual({
        status: 403,
        body: { type: 'NotAllowed', message: expect.any(String) },
      });
      expect((await call(app, 'GET', `/expenses/${id}`, { token: linusToken })).status).toBe(200);
    });

    it('answers a delete by an account outside the group as if the expense did not exist', async () => {
      const id = await recordedExpense();
      const outsider = await accountOf({ email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' });
      expect(await remove(id, outsider.token)).toEqual(notFound);
      expect(await remove('no-such-expense', outsider.token)).toEqual(notFound);
    });

    it('answers 404 to a second delete of the same expense', async () => {
      const id = await recordedExpense();
      expect((await remove(id)).status).toBe(204);
      expect(await remove(id)).toEqual(notFound);
    });

    it('refuses a request without a token with 401', async () => {
      const id = await recordedExpense();
      expect((await call(app, 'DELETE', `/expenses/${id}`)).status).toBe(401);
    });

    it('deletes the expense once when two deletes are made at once through two servers on one database', async () => {
      const id = await recordedExpense();
      const other = await startApplication(database.path);
      try {
        const [first, second] = await Promise.all([
          remove(id),
          call(other, 'DELETE', `/expenses/${id}`, { token: adaToken }),
        ]);
        expect([first.status, second.status].sort()).toEqual([204, 404]);
        expect((await call(app, 'GET', `/expenses/${id}`, { token: adaToken })).status).toBe(404);
      } finally {
        await other.stop();
      }
    });
  });

  describe('the shares of a split by shares', () => {
    it('gives 1001 by shares of 2 and 1, the payer listed second, 667 and 334', () => {
      expect(
        sharesByWeight(
          1001,
          [
            { memberId: graceId, shares: 2 },
            { memberId: adaId, shares: 1 },
          ],
          adaId,
        ),
      ).toEqual([
        { memberId: graceId, amount: 667 },
        { memberId: adaId, amount: 334 },
      ]);
    });

    it('gives the same shares as the equal split when every member has one share', () => {
      const members = [graceId, linusId, adaId];
      expect(
        sharesByWeight(
          1000,
          members.map(memberId => ({ memberId, shares: 1 })),
          adaId,
        ),
      ).toEqual(equalShares(1000, members, adaId));
    });

    it('gives the remainder to the payer even when the payer has the fewest shares', () => {
      expect(
        sharesByWeight(
          1001,
          [
            { memberId: graceId, shares: 3 },
            { memberId: linusId, shares: 1 },
            { memberId: adaId, shares: 1 },
          ],
          adaId,
        ),
      ).toEqual([
        { memberId: graceId, amount: 600 },
        { memberId: linusId, amount: 200 },
        { memberId: adaId, amount: 201 },
      ]);
    });

    it('does the arithmetic in whole numbers, so a huge number of shares cannot overflow it', () => {
      expect(
        sharesByWeight(
          100_000_000,
          [
            { memberId: graceId, shares: 1 },
            { memberId: adaId, shares: 9_000_000_000_000_000 },
          ],
          adaId,
        ),
      ).toEqual([
        { memberId: graceId, amount: 0 },
        { memberId: adaId, amount: 100_000_000 },
      ]);
    });

    it.each([
      [1, [1, 2, 3]],
      [999_983, [5, 3, 11, 2]],
      [100_000_000, [7, 1, 1]],
    ])('never loses a unit: %i split by these shares adds up exactly to the amount', (amount, counts) => {
      const weights = counts.map((shares, index) => ({ memberId: `member-${index}`, shares }));
      const total = sharesByWeight(amount, weights, 'member-0').reduce((sum, share) => sum + share.amount, 0);
      expect(total).toBe(amount);
    });
  });

  describe('the shape of the split', () => {
    it('refuses a body with none of the three splits with 400', async () => {
      const body = expense({ splitBetween: undefined });
      expect((await call(app, 'POST', `/groups/${groupId}/expenses`, { body, token: adaToken })).status).toBe(400);
    });

    it('refuses a body with more than one of the three splits with 400', async () => {
      const exactly = [
        { memberId: adaId, amount: 500 },
        { memberId: graceId, amount: 500 },
      ];
      const byShares = [
        { memberId: adaId, shares: 1 },
        { memberId: graceId, shares: 1 },
      ];
      expect((await record({ splitExactly: exactly })).status).toBe(400);
      expect((await record({ splitByShares: byShares })).status).toBe(400);
      expect((await record({ splitExactly: exactly, splitByShares: byShares })).status).toBe(400);
    });

    it('refuses a split by shares that is not a list of members with their whole numbers of shares, with 400', async () => {
      const splitByShares = [{ memberId: adaId, shares: 1.5 }];
      expect((await record({ splitBetween: undefined, splitByShares })).status).toBe(400);
      expect(
        (await record({ splitBetween: undefined, splitExactly: [{ memberId: adaId, amount: '1000' }] })).status,
      ).toBe(400);
    });

    it('refuses a split by amounts with a fraction of a unit, with 400', async () => {
      const splitExactly = [
        { memberId: adaId, amount: 500.5 },
        { memberId: graceId, amount: 499.5 },
      ];
      expect((await record({ splitBetween: undefined, splitExactly })).status).toBe(400);
    });
  });

  describe('splitting by exact amounts', () => {
    it('gives each member the amount of their share, in the order given, and says the expense is split by amounts', async () => {
      const id = await recordedExpense(
        byAmounts([
          { memberId: linusId, amount: 200 },
          { memberId: adaId, amount: 500 },
          { memberId: graceId, amount: 300 },
        ]),
      );
      expect(await readExpense(id)).toMatchObject({
        splitKind: 'exact',
        shares: [
          { memberId: linusId, amount: 200 },
          { memberId: adaId, amount: 500 },
          { memberId: graceId, amount: 300 },
        ],
      });
    });

    it('accepts the payer alone with the whole amount, and a member with an amount of 0 when the amounts still add up', async () => {
      expect((await record(byAmounts([{ memberId: adaId, amount: 1000 }]))).status).toBe(201);
      expect(
        (
          await record(
            byAmounts([
              { memberId: adaId, amount: 1000 },
              { memberId: graceId, amount: 0 },
            ]),
          )
        ).status,
      ).toBe(201);
    });

    it.each([
      ['less than the amount', 499],
      ['more than the amount', 501],
    ])('refuses amounts that add up to %s of the expense', async (_, graceAmount) => {
      const splitExactly = [
        { memberId: adaId, amount: 500 },
        { memberId: graceId, amount: graceAmount },
      ];
      expect(await record(byAmounts(splitExactly))).toEqual(refusal('InvalidSplit'));
    });

    it('refuses a negative amount, even when the other amounts make up the total', async () => {
      const splitExactly = [
        { memberId: adaId, amount: 1100 },
        { memberId: graceId, amount: -100 },
      ];
      expect(await record(byAmounts(splitExactly))).toEqual(refusal('InvalidSplit'));
    });

    it('refuses a split that does not name the payer, names a member twice, or names an outsider', async () => {
      const outsider = await accountOf({ email: 'outsider@example.com', password: 'outside-2000', name: 'Outsider' });
      expect(
        await record(
          byAmounts([
            { memberId: graceId, amount: 600 },
            { memberId: linusId, amount: 400 },
          ]),
        ),
      ).toEqual(refusal('InvalidSplit'));
      expect(
        await record(
          byAmounts([
            { memberId: adaId, amount: 500 },
            { memberId: graceId, amount: 250 },
            { memberId: graceId, amount: 250 },
          ]),
        ),
      ).toEqual(refusal('InvalidSplit'));
      expect(
        await record(
          byAmounts([
            { memberId: adaId, amount: 500 },
            { memberId: outsider.id, amount: 500 },
          ]),
        ),
      ).toEqual(refusal('InvalidSplit'));
    });

    it('refuses an empty split, which does not name the payer', async () => {
      expect(await record(byAmounts([]))).toEqual(refusal('InvalidSplit'));
    });
  });

  describe('splitting by shares', () => {
    /** The expense split by the shares given, in place of the equal split of the default expense. */
    const byShares = (splitByShares: unknown[], fields: Record<string, unknown> = {}) => ({
      splitBetween: undefined,
      splitByShares,
      ...fields,
    });

    it('gives 1001 by shares of 2 and 1, the payer listed second, 667 to the first and 334 to the payer', async () => {
      const id = await recordedExpense(
        byShares(
          [
            { memberId: graceId, shares: 2 },
            { memberId: adaId, shares: 1 },
          ],
          { amount: 1001 },
        ),
      );
      expect(await readExpense(id)).toMatchObject({
        splitKind: 'shares',
        shares: [
          { memberId: graceId, amount: 667 },
          { memberId: adaId, amount: 334 },
        ],
      });
    });

    it('splits 1000 by shares of 1, 1 and 1 as the equal split does', async () => {
      const id = await recordedExpense(
        byShares([
          { memberId: graceId, shares: 1 },
          { memberId: linusId, shares: 1 },
          { memberId: adaId, shares: 1 },
        ]),
      );
      expect((await readExpense(id)).shares).toEqual([
        { memberId: graceId, amount: 333 },
        { memberId: linusId, amount: 333 },
        { memberId: adaId, amount: 334 },
      ]);
    });

    it.each([0, -1])('refuses a member with %i shares, as each member has at least 1', async shares => {
      const splitByShares = [
        { memberId: adaId, shares: 1 },
        { memberId: graceId, shares },
      ];
      expect(await record(byShares(splitByShares))).toEqual(refusal('InvalidSplit'));
    });

    it('refuses a split by shares that does not name the payer', async () => {
      const splitByShares = [
        { memberId: graceId, shares: 1 },
        { memberId: linusId, shares: 1 },
      ];
      expect(await record(byShares(splitByShares))).toEqual(refusal('InvalidSplit'));
    });
  });

  describe('editing the split', () => {
    it('turns an equal split into one by amounts, and counts one more version', async () => {
      const id = await recordedExpense();
      const answer = await change(id, {
        splitBetween: undefined,
        splitExactly: [
          { memberId: adaId, amount: 400 },
          { memberId: graceId, amount: 600 },
        ],
      });
      expect(answer.status).toBe(204);
      expect(await readExpense(id)).toMatchObject({
        splitKind: 'exact',
        version: 2,
        shares: [
          { memberId: adaId, amount: 400 },
          { memberId: graceId, amount: 600 },
        ],
      });
    });

    it('turns a split by amounts into one by shares, and then into an equal one', async () => {
      const id = await recordedExpense();
      await change(id, {
        splitBetween: undefined,
        splitByShares: [
          { memberId: adaId, shares: 1 },
          { memberId: graceId, shares: 3 },
        ],
      });
      expect(await readExpense(id)).toMatchObject({
        splitKind: 'shares',
        version: 2,
        shares: [
          { memberId: adaId, amount: 250 },
          { memberId: graceId, amount: 750 },
        ],
      });
      expect(await change(id, { version: 2 })).toEqual({ status: 204, body: undefined });
      expect(await readExpense(id)).toMatchObject({ splitKind: 'equal', version: 3 });
    });

    it('refuses an edit that gives two splits, or none, with 400, and keeps the expense', async () => {
      const id = await recordedExpense();
      expect(
        (
          await change(id, {
            splitExactly: [
              { memberId: adaId, amount: 1000 },
              { memberId: graceId, amount: 0 },
            ],
          })
        ).status,
      ).toBe(400);
      expect((await change(id, { splitBetween: undefined })).status).toBe(400);
      expect(await readExpense(id)).toMatchObject({ splitKind: 'equal', version: 1 });
    });

    it('refuses an edit whose amounts no longer add up to the new amount, and keeps nothing of it', async () => {
      const id = await recordedExpense(
        byAmounts([
          { memberId: adaId, amount: 600 },
          { memberId: graceId, amount: 400 },
        ]),
      );
      const answer = await change(id, {
        amount: 900,
        splitBetween: undefined,
        splitExactly: [
          { memberId: adaId, amount: 600 },
          { memberId: graceId, amount: 400 },
        ],
      });
      expect(answer).toEqual(refusal('InvalidSplit'));
      expect(await readExpense(id)).toMatchObject({ amount: 1000, splitKind: 'exact', version: 1 });
    });
  });

  describe('the balances of an unequal split', () => {
    it("counts each member's share of an expense split by amounts or by shares, in the balances", async () => {
      await recordedExpense({
        splitBetween: undefined,
        splitExactly: [
          { memberId: adaId, amount: 700 },
          { memberId: graceId, amount: 300 },
        ],
      });
      await recordedExpense(
        {
          amount: 1001,
          splitBetween: undefined,
          splitByShares: [
            { memberId: graceId, shares: 2 },
            { memberId: adaId, shares: 1 },
          ],
        },
        graceToken,
      );
      // Ada paid 1000 and has shares 700 + 333. Grace paid 1001 and has shares 300 + 668: the payer keeps
      // the remainder of 1001 split by 2 and 1 shares, 668 and 333. Linus has no share, and is even.
      expect((await balancesOf()).map((member: { balance: number }) => member.balance)).toEqual([-33, 33, 0]);
    });
  });
});
