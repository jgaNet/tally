import { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { equalShares, sharesByCount } from './expenses';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The split a test body is given when its fields name none: an empty equal split (refused as
 * `SplitIsEmpty`), unless they name an exact split or a split by shares, which a body may not add to.
 */
function splitDefault(fields: Record<string, unknown>): Record<string, unknown> {
  return 'splitExactly' in fields || 'splitByShares' in fields ? {} : { splitBetween: [] };
}

describe('expenses', () => {
  describe('splitting equally', () => {
    it('gives the remainder to the first member listed: 1000 between three is 334, 333 and 333', () => {
      expect(equalShares(1000, ['ana', 'ben', 'cleo'])).toEqual([
        { memberId: 'ana', amount: 334 },
        { memberId: 'ben', amount: 333 },
        { memberId: 'cleo', amount: 333 },
      ]);
    });

    it('gives the remainder to the first member listed, whoever is named second: 1000 between cleo, ben and ana is 334 for cleo', () => {
      expect(equalShares(1000, ['cleo', 'ben', 'ana'])).toEqual([
        { memberId: 'cleo', amount: 334 },
        { memberId: 'ben', amount: 333 },
        { memberId: 'ana', amount: 333 },
      ]);
    });

    it('answers the shares in the order of the split', () => {
      expect(equalShares(1000, ['cleo', 'ben', 'ana']).map(share => share.memberId)).toEqual(['cleo', 'ben', 'ana']);
    });

    it('gives every member the same share when nothing is left over', () => {
      expect(equalShares(900, ['ana', 'ben', 'cleo'])).toEqual([
        { memberId: 'ana', amount: 300 },
        { memberId: 'ben', amount: 300 },
        { memberId: 'cleo', amount: 300 },
      ]);
    });

    it('gives a lone member the whole amount', () => {
      expect(equalShares(4321, ['ana'])).toEqual([{ memberId: 'ana', amount: 4321 }]);
    });

    it('makes the shares add up to the amount exactly, the first member’s share being the only one over the base, whatever the amount and the number', () => {
      const amounts = [1, 2, 3, 7, 99, 100, 101, 999, 1000, 65_537, 99_999_999, 100_000_000];
      for (const amount of amounts) {
        for (let count = 1; count <= 7; count++) {
          const memberIds = Array.from({ length: count }, (_, index) => `m${index}`);
          const shares = equalShares(amount, memberIds);
          const total = shares.reduce((sum, share) => sum + share.amount, 0);
          expect(total).toBe(amount);
          expect(shares.every(share => Number.isInteger(share.amount) && share.amount >= 0)).toBe(true);
          const base = Math.floor(amount / count);
          shares.forEach((share, index) => {
            if (index === 0) {
              expect(share.amount - base).toBeGreaterThanOrEqual(0);
              expect(share.amount - base).toBeLessThan(count);
            } else {
              expect(share.amount).toBe(base);
            }
          });
        }
      }
    });
  });

  describe('splitting by shares', () => {
    it('divides 1001 by shares of 2 and 1, the first member listed being the one with 2, as 668 and 333', () => {
      expect(
        sharesByCount(1001, [
          { memberId: 'ana', shares: 2 },
          { memberId: 'ben', shares: 1 },
        ]),
      ).toEqual([
        { memberId: 'ana', amount: 668 },
        { memberId: 'ben', amount: 333 },
      ]);
    });

    it('divides by one share each as the equal split does', () => {
      const memberIds = ['ana', 'ben', 'cleo'];
      expect(
        sharesByCount(
          1000,
          memberIds.map(memberId => ({ memberId, shares: 1 })),
        ),
      ).toEqual(equalShares(1000, memberIds));
    });

    it('is exact however large the shares: 100 000 000 by shares of 1 and 2^53 - 1 is 1 and 99 999 999', () => {
      expect(
        sharesByCount(100_000_000, [
          { memberId: 'ben', shares: 1 },
          { memberId: 'ana', shares: Number.MAX_SAFE_INTEGER },
        ]),
      ).toEqual([
        { memberId: 'ben', amount: 1 },
        { memberId: 'ana', amount: 99_999_999 },
      ]);
    });

    it('makes the shares add up to the amount exactly, the first member’s share being the only one over its floor by less than the number of members', () => {
      const amounts = [1, 2, 3, 7, 99, 100, 101, 999, 65_537, 99_999_999, 100_000_000];
      for (const amount of amounts) {
        for (let count = 1; count <= 5; count++) {
          const memberIds = Array.from({ length: count }, (_, index) => `m${index}`);
          const parts = memberIds.map((memberId, index) => ({ memberId, shares: ((index * 7) % 5) + 1 }));
          const total = parts.reduce((sum, part) => sum + part.shares, 0);
          const shares = sharesByCount(amount, parts);
          expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(amount);
          for (const [index, share] of shares.entries()) {
            const floor = Math.floor((amount * parts[index].shares) / total);
            if (index === 0) {
              expect(share.amount - floor).toBeGreaterThanOrEqual(0);
              expect(share.amount - floor).toBeLessThan(count);
            } else {
              expect(share.amount).toBe(floor);
            }
          }
        }
      }
    });
  });

  describe('recording and reading an expense', () => {
    let directory: TestDirectory;
    let app: Application;
    let db: DatabaseSync;

    beforeEach(async () => {
      directory = testDirectory();
      app = await startApplication(directory.databasePath);
      // A second connection to the same file, to count what was stored.
      db = openDatabase(directory.databasePath);
    });

    afterEach(async () => {
      db.close();
      await app.stop();
      directory.remove();
    });

    /** Creates a group as `token`'s account and answers its id. */
    async function createGroup(token: string): Promise<string> {
      const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Flat', currency: 'EUR' } });
      if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
      return (reply.body as { id: string }).id;
    }

    /** Makes the account of `token` a member of `groupId`, through an invitation its owner creates. */
    async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
      const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
      const id = (invitation.body as { id: string }).id;
      const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: joinerToken });
      if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
    }

    /** Records an expense in `groupId` as `token`'s account, with the given fields overridden. */
    async function record(
      token: string,
      groupId: string,
      fields: Partial<{
        description: unknown;
        amount: unknown;
        date: unknown;
        splitBetween: unknown;
        splitExactly: unknown;
        splitByShares: unknown;
      }> = {},
    ) {
      return send(app, 'POST', `/groups/${groupId}/expenses`, {
        token,
        body: {
          description: 'Groceries',
          amount: 1000,
          date: utcDay(0),
          ...splitDefault(fields),
          ...fields,
        },
      });
    }

    /** Records an expense split between the members `ids` and answers its id; it must be accepted. */
    async function recordOk(token: string, groupId: string, ids: string[], amount = 1000): Promise<string> {
      const reply = await record(token, groupId, { splitBetween: ids, amount });
      if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
      return (reply.body as { id: string }).id;
    }

    /** How many expenses and shares the file holds, read on the second connection. */
    function storedCounts(): { expenses: number; shares: number } {
      const expenses = db.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number };
      const shares = db.prepare('SELECT COUNT(*) AS n FROM expense_shares').get() as { n: number };
      return { expenses: expenses.n, shares: shares.n };
    }

    describe('recording', () => {
      it('answers the id of the new expense, as a member records it', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const reply = await record(ana.token, groupId, { splitBetween: [ana.id] });
        expect(reply.status).toBe(201);
        expect(reply.body).toEqual({ id: expect.any(String) });
      });

      it('makes the caller the payer, whatever the order of the split', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const id = await recordOk(ben.token, groupId, [ana.id, ben.id]);
        const expense = await send(app, 'GET', `/expenses/${id}`, { token: ana.token });
        expect(expense.body).toMatchObject({ paidBy: ben.id });
      });

      it('splits the amount equally, the remainder to the first member listed, the payer not being first', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        await join(ana.token, groupId, cleo.token);
        const id = await recordOk(cleo.token, groupId, [ana.id, cleo.id, ben.id], 1000);
        const expense = await send(app, 'GET', `/expenses/${id}`, { token: cleo.token });
        expect(expense.body).toMatchObject({
          amount: 1000,
          shares: [
            { memberId: ana.id, amount: 334 },
            { memberId: cleo.id, amount: 333 },
            { memberId: ben.id, amount: 333 },
          ],
        });
      });

      it('keeps the shares an expense recorded before the remainder moved to the first member: they are not computed again', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        await join(ana.token, groupId, cleo.token);
        const id = await recordOk(cleo.token, groupId, [ana.id, cleo.id, ben.id], 1000);
        // As the expense was stored before the change: the remainder on the payer's share, cleo's, is 334.
        db.prepare('UPDATE expense_shares SET amount = ? WHERE expense_id = ? AND member_id = ?').run(333, id, ana.id);
        db.prepare('UPDATE expense_shares SET amount = ? WHERE expense_id = ? AND member_id = ?').run(334, id, cleo.id);
        const expense = await send(app, 'GET', `/expenses/${id}`, { token: ana.token });
        expect(expense.body).toMatchObject({
          shares: [
            { memberId: ana.id, amount: 333 },
            { memberId: cleo.id, amount: 334 },
            { memberId: ben.id, amount: 333 },
          ],
        });
      });

      it('records a lone payer splitting an expense on their own', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const id = await recordOk(ana.token, groupId, [ana.id], 77);
        const expense = await send(app, 'GET', `/expenses/${id}`, { token: ana.token });
        expect(expense.body).toMatchObject({ shares: [{ memberId: ana.id, amount: 77 }] });
      });

      it('gives each expense its own id', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const first = await recordOk(ana.token, groupId, [ana.id]);
        const second = await recordOk(ana.token, groupId, [ana.id]);
        expect(first).not.toBe(second);
      });

      it('stores the description trimmed of surrounding spaces', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const reply = await record(ana.token, groupId, { description: '  Groceries  ', splitBetween: [ana.id] });
        const expense = await send(app, 'GET', `/expenses/${(reply.body as { id: string }).id}`, {
          token: ana.token,
        });
        expect(expense.body).toMatchObject({ description: 'Groceries' });
      });

      it.each([
        ['an empty description', ''],
        ['a description of only spaces', '   '],
        ['a description of 101 characters', 'a'.repeat(101)],
        ['a description of 101 emoji', '😀'.repeat(101)],
      ])('refuses %s with 422', async (_label, description) => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const reply = await record(ana.token, groupId, { description, splitBetween: [ana.id] });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'DescriptionIsInvalid' });
      });

      it('accepts a description of 1 or 100 characters, counting an emoji once', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const one = await record(ana.token, groupId, { description: 'A', splitBetween: [ana.id] });
        const hundred = await record(ana.token, groupId, { description: 'a'.repeat(100), splitBetween: [ana.id] });
        const emoji = await record(ana.token, groupId, { description: '😀'.repeat(100), splitBetween: [ana.id] });
        expect([one.status, hundred.status, emoji.status]).toEqual([201, 201, 201]);
      });

      it.each([0, -1, 100_000_001, 1.5, Number.MAX_SAFE_INTEGER])(
        'refuses the amount %p, which is not a whole number from 1 to 100 000 000, with 422',
        async amount => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const reply = await record(ana.token, groupId, { amount, splitBetween: [ana.id] });
          expect(reply.status).toBe(422);
          expect(reply.body).toMatchObject({ error: 'AmountIsInvalid' });
        },
      );

      it('accepts the amounts 1 and 100 000 000', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const least = await record(ana.token, groupId, { amount: 1, splitBetween: [ana.id] });
        const most = await record(ana.token, groupId, { amount: 100_000_000, splitBetween: [ana.id] });
        expect([least.status, most.status]).toEqual([201, 201]);
      });

      it.each(['2026-02-30', '2026-02-29', '2026-13-01', '2026-00-10', '2026-1-5', '20260105', 'yesterday'])(
        'refuses the date %j, which is not a real day written YYYY-MM-DD, with 422',
        async date => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const reply = await record(ana.token, groupId, { date, splitBetween: [ana.id] });
          expect(reply.status).toBe(422);
          expect(reply.body).toMatchObject({ error: 'DateIsInvalid' });
        },
      );

      it('accepts a real day, including a leap day of a leap year and today', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const leapDay = await record(ana.token, groupId, { date: '2024-02-29', splitBetween: [ana.id] });
        const today = await record(ana.token, groupId, { date: utcDay(0), splitBetween: [ana.id] });
        expect([leapDay.status, today.status]).toEqual([201, 201]);
      });

      it('refuses a date after today in UTC with 422, and accepts yesterday', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const tomorrow = await record(ana.token, groupId, { date: utcDay(1), splitBetween: [ana.id] });
        const yesterday = await record(ana.token, groupId, { date: utcDay(-1), splitBetween: [ana.id] });
        expect(tomorrow.status).toBe(422);
        expect(tomorrow.body).toMatchObject({ error: 'DateIsInTheFuture' });
        expect(yesterday.status).toBe(201);
      });

      it('refuses an empty split with 422', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const reply = await record(ana.token, groupId, { splitBetween: [] });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'SplitIsEmpty' });
      });

      it('refuses a member listed twice in the split with 422', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const reply = await record(ana.token, groupId, { splitBetween: [ana.id, ben.id, ben.id] });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'SplitRepeatsAMember' });
      });

      it('refuses a split naming an account that is not a member of the group with 422', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        const reply = await record(ana.token, groupId, { splitBetween: [ana.id, ben.id] });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'MemberNotInGroup' });
      });

      it('refuses a split that leaves out the payer, with 422', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const reply = await record(ana.token, groupId, { splitBetween: [ben.id] });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'PayerNotInSplit' });
      });

      it('stores nothing for a refused expense', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        await recordOk(ana.token, groupId, [ana.id]);
        const before = storedCounts();
        expect((await record(ana.token, groupId, { amount: 0, splitBetween: [ana.id] })).status).toBe(422);
        expect((await record(ana.token, groupId, { splitBetween: ['nobody'] })).status).toBe(422);
        expect(storedCounts()).toEqual(before);
      });

      it('answers 404 to a signed-in account that is not a member, as if the group did not exist', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        const outsider = await record(ben.token, groupId, { splitBetween: [ben.id] });
        const missing = await record(ben.token, 'no-such-group', { splitBetween: [ben.id] });
        expect(outsider.status).toBe(404);
        expect(outsider.body).toMatchObject({ error: 'GroupNotFound' });
        expect(outsider.body).toEqual(missing.body);
        expect(storedCounts().expenses).toBe(0);
      });

      it('refuses a request with no token, or an unproven one, with 401', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const body = { description: 'Groceries', amount: 1000, date: utcDay(0), splitBetween: [ana.id] };
        const anonymous = await send(app, 'POST', `/groups/${groupId}/expenses`, { body });
        const unproven = await send(app, 'POST', `/groups/${groupId}/expenses`, { token: 'not-a-real-token', body });
        expect(anonymous.status).toBe(401);
        expect(unproven.status).toBe(401);
        expect(storedCounts().expenses).toBe(0);
      });

      it('refuses a body missing a field, or with a field of the wrong type, with 400', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const valid = { description: 'Groceries', amount: 1000, date: utcDay(0), splitBetween: [ana.id] };
        const bodies: unknown[] = [
          { ...valid, description: undefined },
          { ...valid, amount: undefined },
          { ...valid, date: undefined },
          { ...valid, splitBetween: undefined },
          { ...valid, amount: '1000' },
          { ...valid, splitBetween: ana.id },
          { ...valid, splitBetween: [42] },
          ['not', 'an', 'object'],
        ];
        for (const body of bodies) {
          const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, { token: ana.token, body });
          expect(reply.status).toBe(400);
        }
      });
    });

    describe('reading', () => {
      it('answers the expense to its payer: description, amount, date, payer and shares', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const date = utcDay(-2);
        const reply = await record(ana.token, groupId, {
          description: 'Groceries',
          amount: 1001,
          date,
          splitBetween: [ana.id, ben.id],
        });
        const id = (reply.body as { id: string }).id;
        const read = await send(app, 'GET', `/expenses/${id}`, { token: ana.token });
        expect(read.status).toBe(200);
        expect(read.body).toEqual({
          id,
          groupId,
          description: 'Groceries',
          amount: 1001,
          date,
          paidBy: ana.id,
          version: 1,
          splitKind: 'equal',
          shares: [
            { memberId: ana.id, amount: 501 },
            { memberId: ben.id, amount: 500 },
          ],
        });
      });

      it('answers the same expense to another member of the group, who is not its payer', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const id = await recordOk(ben.token, groupId, [ben.id, ana.id]);
        const asPayer = await send(app, 'GET', `/expenses/${id}`, { token: ben.token });
        const asMember = await send(app, 'GET', `/expenses/${id}`, { token: ana.token });
        expect(asMember.status).toBe(200);
        expect(asMember.body).toEqual(asPayer.body);
      });

      it('answers 404 to a signed-in account outside the group, as if the expense did not exist', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        const id = await recordOk(ana.token, groupId, [ana.id]);
        const outsider = await send(app, 'GET', `/expenses/${id}`, { token: ben.token });
        const missing = await send(app, 'GET', '/expenses/no-such-expense', { token: ben.token });
        expect(outsider.status).toBe(404);
        expect(outsider.body).toMatchObject({ error: 'ExpenseNotFound' });
        expect(outsider.body).toEqual(missing.body);
      });

      it('refuses a request with no token, or an unproven one, with 401', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const id = await recordOk(ana.token, groupId, [ana.id]);
        expect((await send(app, 'GET', `/expenses/${id}`)).status).toBe(401);
        expect((await send(app, 'GET', `/expenses/${id}`, { token: 'not-a-real-token' })).status).toBe(401);
      });

      it('stays the same however often it is read', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const id = await recordOk(ana.token, groupId, [ana.id], 500);
        const first = await send(app, 'GET', `/expenses/${id}`, { token: ana.token });
        const second = await send(app, 'GET', `/expenses/${id}`, { token: ana.token });
        expect(second.body).toEqual(first.body);
        expect(storedCounts()).toEqual({ expenses: 1, shares: 1 });
      });
    });

    describe('splitting by exact amounts and by shares', () => {
      /** The body of an expense of 1000 on `utcDay(0)`, to which a split is added. */
      const base = { description: 'Groceries', amount: 1000, date: utcDay(0) };

      it('records a split by exact amounts, and reads each amount in the order given, as exact', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const reply = await record(ben.token, groupId, {
          splitExactly: [
            { memberId: ana.id, amount: 700 },
            { memberId: ben.id, amount: 300 },
          ],
        });
        expect(reply.status).toBe(201);
        const id = (reply.body as { id: string }).id;
        expect((await send(app, 'GET', `/expenses/${id}`, { token: ana.token })).body).toEqual({
          id,
          groupId,
          description: 'Groceries',
          amount: 1000,
          date: utcDay(0),
          paidBy: ben.id,
          version: 1,
          splitKind: 'exact',
          shares: [
            { memberId: ana.id, amount: 700 },
            { memberId: ben.id, amount: 300 },
          ],
        });
      });

      it('accepts an exact amount of 0 for a member who owes nothing', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const reply = await record(ana.token, groupId, {
          splitExactly: [
            { memberId: ana.id, amount: 1000 },
            { memberId: ben.id, amount: 0 },
          ],
        });
        expect(reply.status).toBe(201);
        const id = (reply.body as { id: string }).id;
        expect((await send(app, 'GET', `/expenses/${id}`, { token: ana.token })).body).toMatchObject({
          shares: [
            { memberId: ana.id, amount: 1000 },
            { memberId: ben.id, amount: 0 },
          ],
        });
      });

      it('divides by shares: 1001 by shares of 2 and 1, the first member listed having 2, is 668 and 333', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const reply = await record(ben.token, groupId, {
          amount: 1001,
          splitByShares: [
            { memberId: ana.id, shares: 2 },
            { memberId: ben.id, shares: 1 },
          ],
        });
        expect(reply.status).toBe(201);
        const id = (reply.body as { id: string }).id;
        expect((await send(app, 'GET', `/expenses/${id}`, { token: ben.token })).body).toMatchObject({
          amount: 1001,
          splitKind: 'shares',
          shares: [
            { memberId: ana.id, amount: 668 },
            { memberId: ben.id, amount: 333 },
          ],
        });
      });

      it('divides 1000 by shares of 1, 1 and 1 as an equal split does, the remainder to the first member listed', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        await join(ana.token, groupId, cleo.token);
        const reply = await record(ana.token, groupId, {
          splitByShares: [
            { memberId: ana.id, shares: 1 },
            { memberId: ben.id, shares: 1 },
            { memberId: cleo.id, shares: 1 },
          ],
        });
        const id = (reply.body as { id: string }).id;
        expect((await send(app, 'GET', `/expenses/${id}`, { token: ana.token })).body).toMatchObject({
          splitKind: 'shares',
          shares: [
            { memberId: ana.id, amount: 334 },
            { memberId: ben.id, amount: 333 },
            { memberId: cleo.id, amount: 333 },
          ],
        });
      });

      it('refuses exact amounts that do not add up to the amount, with 422, and stores nothing', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const reply = await record(ana.token, groupId, {
          splitExactly: [
            { memberId: ana.id, amount: 500 },
            { memberId: ben.id, amount: 499 },
          ],
        });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'AmountsDoNotAddUp' });
        expect(storedCounts()).toEqual({ expenses: 0, shares: 0 });
      });

      it.each<[string, number, number]>([
        ['a negative amount', -100, 1100],
        ['an amount with pence', 500.5, 499.5],
      ])(
        'refuses an exact split with %s, with 422 ShareAmountIsInvalid, and stores nothing',
        async (_label, ana, ben) => {
          const anaAccount = await signedUpAccount(app, { email: 'ana@example.org' });
          const benAccount = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(anaAccount.token);
          await join(anaAccount.token, groupId, benAccount.token);
          const reply = await record(anaAccount.token, groupId, {
            splitExactly: [
              { memberId: anaAccount.id, amount: ana },
              { memberId: benAccount.id, amount: ben },
            ],
          });
          expect(reply.status).toBe(422);
          expect(reply.body).toMatchObject({ error: 'ShareAmountIsInvalid' });
          expect(storedCounts()).toEqual({ expenses: 0, shares: 0 });
        },
      );

      it.each<[string, number]>([
        ['no share', 0],
        ['a negative share', -1],
        ['a share with a fraction', 1.5],
      ])('refuses a split by shares with %s, with 422 SharesAreInvalid, and stores nothing', async (_label, shares) => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const ben = await signedUpAccount(app, { email: 'ben@example.org' });
        const groupId = await createGroup(ana.token);
        await join(ana.token, groupId, ben.token);
        const reply = await record(ana.token, groupId, {
          splitByShares: [
            { memberId: ana.id, shares: 1 },
            { memberId: ben.id, shares },
          ],
        });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'SharesAreInvalid' });
        expect(storedCounts()).toEqual({ expenses: 0, shares: 0 });
      });

      it('refuses a body that names none of the three splits, or more than one, with 400, and stores nothing', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const exact = [{ memberId: ana.id, amount: 1000 }];
        const shares = [{ memberId: ana.id, shares: 1 }];
        const bodies: Record<string, unknown>[] = [
          {},
          { splitBetween: [ana.id], splitExactly: exact },
          { splitExactly: exact, splitByShares: shares },
          { splitBetween: [ana.id], splitByShares: shares },
          { splitBetween: [ana.id], splitExactly: exact, splitByShares: shares },
          { splitExactly: [{ memberId: ana.id }] },
          { splitExactly: [{ memberId: ana.id, amount: '1000' }] },
          { splitByShares: [{ memberId: ana.id, shares: '1' }] },
          { splitByShares: [{ memberId: ana.id }] },
        ];
        for (const split of bodies) {
          const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
            token: ana.token,
            body: { ...base, ...split },
          });
          expect(reply.status).toBe(400);
        }
        expect(storedCounts()).toEqual({ expenses: 0, shares: 0 });
      });

      it.each<[string, 'splitExactly' | 'splitByShares', (ids: { ana: string; ben: string }) => unknown[], string]>([
        [
          'a member listed twice',
          'splitExactly',
          ({ ana }) => [
            { memberId: ana, amount: 500 },
            { memberId: ana, amount: 500 },
          ],
          'SplitRepeatsAMember',
        ],
        [
          'a member listed twice by shares',
          'splitByShares',
          ({ ana }) => [
            { memberId: ana, shares: 1 },
            { memberId: ana, shares: 1 },
          ],
          'SplitRepeatsAMember',
        ],
        [
          'an account outside the group',
          'splitExactly',
          ({ ana }) => [
            { memberId: ana, amount: 500 },
            { memberId: 'nobody', amount: 500 },
          ],
          'MemberNotInGroup',
        ],
        ['the payer left out', 'splitByShares', ({ ben }) => [{ memberId: ben, shares: 1 }], 'PayerNotInSplit'],
        ['an empty split', 'splitExactly', () => [], 'SplitIsEmpty'],
        ['an empty split by shares', 'splitByShares', () => [], 'SplitIsEmpty'],
      ])(
        'refuses %s with the rule that breaks it, with 422, and stores nothing',
        async (_label, field, partsFor, rule) => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const reply = await record(ana.token, groupId, { [field]: partsFor({ ana: ana.id, ben: ben.id }) });
          expect(reply.status).toBe(422);
          expect(reply.body).toMatchObject({ error: rule });
          expect(storedCounts()).toEqual({ expenses: 0, shares: 0 });
        },
      );
    });

    describe('editing and deleting', () => {
      let directory: TestDirectory;
      let app: Application;
      let db: DatabaseSync;

      beforeEach(async () => {
        directory = testDirectory();
        app = await startApplication(directory.databasePath);
        db = openDatabase(directory.databasePath);
      });

      afterEach(async () => {
        db.close();
        await app.stop();
        directory.remove();
      });

      async function createGroup(token: string): Promise<string> {
        const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Flat', currency: 'EUR' } });
        if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
        return (reply.body as { id: string }).id;
      }

      async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
        const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
        const id = (invitation.body as { id: string }).id;
        const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: joinerToken });
        if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
      }

      /** Records an expense in `groupId` as `token`'s account, split between `ids`; answers its id. */
      async function recordOk(token: string, groupId: string, ids: string[], amount = 1000): Promise<string> {
        const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
          token,
          body: { description: 'Groceries', amount, date: utcDay(0), splitBetween: ids },
        });
        if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
        return (reply.body as { id: string }).id;
      }

      /** Edits the expense `id` as `token`'s account, the body being a valid edit from version 1 unless overridden. */
      async function edit(token: string, id: string, fields: Record<string, unknown> = {}) {
        return send(app, 'PUT', `/expenses/${id}`, {
          token,
          body: {
            description: 'Groceries',
            amount: 1000,
            date: utcDay(0),
            ...splitDefault(fields),
            version: 1,
            ...fields,
          },
        });
      }

      async function read(token: string, id: string) {
        return send(app, 'GET', `/expenses/${id}`, { token });
      }

      async function balancesOf(token: string, groupId: string): Promise<Record<string, number>> {
        const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
        const balances = reply.body as { memberId: string; balance: number }[];
        return Object.fromEntries(balances.map(balance => [balance.memberId, balance.balance]));
      }

      function storedCounts(): { expenses: number; shares: number } {
        const expenses = db.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number };
        const shares = db.prepare('SELECT COUNT(*) AS n FROM expense_shares').get() as { n: number };
        return { expenses: expenses.n, shares: shares.n };
      }

      describe('editing', () => {
        it('recording gives an expense version 1, and reading it shows the version', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          expect((await read(ana.token, id)).body).toMatchObject({ version: 1 });
        });

        it('replaces the expense, whole, as its payer edits it: the new fields, the shares computed again, the next version', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const id = await recordOk(ana.token, groupId, [ana.id, ben.id], 1000);
          const reply = await edit(ana.token, id, {
            description: '  Dinner  ',
            amount: 901,
            date: utcDay(-1),
            splitBetween: [ben.id, ana.id],
          });
          expect(reply.status).toBe(200);
          expect(reply.body).toEqual({
            id,
            groupId,
            description: 'Dinner',
            amount: 901,
            date: utcDay(-1),
            paidBy: ana.id,
            version: 2,
            splitKind: 'equal',
            shares: [
              { memberId: ben.id, amount: 451 },
              { memberId: ana.id, amount: 450 },
            ],
          });
          expect((await read(ben.token, id)).body).toEqual(reply.body);
        });

        it('lets the payer edit an expense the owner did not pay, and keeps the payer', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const id = await recordOk(ben.token, groupId, [ben.id, ana.id]);
          const reply = await edit(ben.token, id, { splitBetween: [ben.id] });
          expect(reply.status).toBe(200);
          expect(reply.body).toMatchObject({
            paidBy: ben.id,
            version: 2,
            shares: [{ memberId: ben.id, amount: 1000 }],
          });
        });

        it('lets the owner edit an expense another member paid, and the payer stays the one who paid', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const id = await recordOk(ben.token, groupId, [ben.id, ana.id]);
          const reply = await edit(ana.token, id, { amount: 601, splitBetween: [ana.id, ben.id] });
          expect(reply.status).toBe(200);
          expect(reply.body).toMatchObject({
            paidBy: ben.id,
            amount: 601,
            version: 2,
            shares: [
              { memberId: ana.id, amount: 301 },
              { memberId: ben.id, amount: 300 },
            ],
          });
        });

        it('refuses an owner edit that leaves the payer out of the split, with 422 PayerNotInSplit', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const id = await recordOk(ben.token, groupId, [ben.id, ana.id]);
          const before = (await read(ana.token, id)).body;
          const reply = await edit(ana.token, id, { splitBetween: [ana.id] });
          expect(reply.status).toBe(422);
          expect(reply.body).toMatchObject({ error: 'PayerNotInSplit' });
          expect((await read(ana.token, id)).body).toEqual(before);
        });

        it('refuses an edit by another member who is neither the payer nor the owner, with 403, and keeps nothing', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          await join(ana.token, groupId, cleo.token);
          const id = await recordOk(ben.token, groupId, [ben.id, ana.id]);
          const before = (await read(ana.token, id)).body;
          const reply = await edit(cleo.token, id, { amount: 1 });
          expect(reply.status).toBe(403);
          expect(reply.body).toMatchObject({ error: 'NotPayerOrOwner' });
          expect((await read(ana.token, id)).body).toEqual(before);
        });

        it('answers 404 to a signed-in account outside the group, as if the expense did not exist', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          const outsider = await edit(ben.token, id, { splitBetween: [ben.id] });
          const missing = await edit(ben.token, 'no-such-expense', { splitBetween: [ben.id] });
          expect(outsider.status).toBe(404);
          expect(outsider.body).toMatchObject({ error: 'ExpenseNotFound' });
          expect(outsider.body).toEqual(missing.body);
        });

        it('refuses an edit made from a version the expense has since left, with 409, and keeps nothing', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          expect((await edit(ana.token, id, { amount: 700, splitBetween: [ana.id] })).status).toBe(200);
          const stale = await edit(ana.token, id, { amount: 300, splitBetween: [ana.id], version: 1 });
          expect(stale.status).toBe(409);
          expect(stale.body).toMatchObject({ error: 'ExpenseChanged' });
          expect((await read(ana.token, id)).body).toMatchObject({ amount: 700, version: 2 });
        });

        it('refuses an edit made from a version the expense has not reached, with 409', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          const ahead = await edit(ana.token, id, { splitBetween: [ana.id], version: 2 });
          expect(ahead.status).toBe(409);
          expect(ahead.body).toMatchObject({ error: 'ExpenseChanged' });
        });

        it('replaces how an expense was split as its payer edits it: exact, then by shares, then equal again', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const id = await recordOk(ana.token, groupId, [ana.id, ben.id], 1000);
          const exact = await edit(ana.token, id, {
            splitExactly: [
              { memberId: ana.id, amount: 200 },
              { memberId: ben.id, amount: 800 },
            ],
          });
          expect(exact.status).toBe(200);
          expect(exact.body).toMatchObject({
            version: 2,
            splitKind: 'exact',
            shares: [
              { memberId: ana.id, amount: 200 },
              { memberId: ben.id, amount: 800 },
            ],
          });
          const byShares = await edit(ana.token, id, {
            splitByShares: [
              { memberId: ana.id, shares: 1 },
              { memberId: ben.id, shares: 3 },
            ],
            version: 2,
          });
          expect(byShares.body).toMatchObject({
            version: 3,
            splitKind: 'shares',
            shares: [
              { memberId: ana.id, amount: 250 },
              { memberId: ben.id, amount: 750 },
            ],
          });
          const equal = await edit(ana.token, id, { splitBetween: [ana.id, ben.id], version: 3 });
          expect(equal.body).toMatchObject({
            version: 4,
            splitKind: 'equal',
            shares: [
              { memberId: ana.id, amount: 500 },
              { memberId: ben.id, amount: 500 },
            ],
          });
          expect(storedCounts()).toEqual({ expenses: 1, shares: 2 });
        });

        it('refuses an edit naming two splits with 400, and an edit whose exact amounts do not add up with 422, keeping the expense', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id], 1000);
          const before = (await read(ana.token, id)).body;
          const twoSplits = await edit(ana.token, id, {
            splitBetween: [ana.id],
            splitExactly: [{ memberId: ana.id, amount: 1000 }],
          });
          expect(twoSplits.status).toBe(400);
          const unequal = await edit(ana.token, id, { splitExactly: [{ memberId: ana.id, amount: 999 }] });
          expect(unequal.status).toBe(422);
          expect(unequal.body).toMatchObject({ error: 'AmountsDoNotAddUp' });
          expect((await read(ana.token, id)).body).toEqual(before);
        });

        it('refuses a version that is not a whole number from 1, with 400', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          const before = (await read(ana.token, id)).body;
          for (const version of [undefined, 0, -1, 1.5, '1', null]) {
            const reply = await edit(ana.token, id, { splitBetween: [ana.id], version });
            expect(reply.status).toBe(400);
          }
          expect((await read(ana.token, id)).body).toEqual(before);
        });

        // Each case gives the fields of the edit, given the id of the payer, who is the only member.
        it.each<[string, (payerId: string) => Record<string, unknown>, string]>([
          ['an empty description', () => ({ description: '' }), 'DescriptionIsInvalid'],
          ['a description of 101 characters', () => ({ description: 'a'.repeat(101) }), 'DescriptionIsInvalid'],
          ['an amount of 0', () => ({ amount: 0 }), 'AmountIsInvalid'],
          ['an amount with pence', () => ({ amount: 10.5 }), 'AmountIsInvalid'],
          ['a date that is not a real day', () => ({ date: '2026-02-30' }), 'DateIsInvalid'],
          ['a date after today', () => ({ date: utcDay(1) }), 'DateIsInTheFuture'],
          ['an empty split', () => ({ splitBetween: [] }), 'SplitIsEmpty'],
          ['a member listed twice', payer => ({ splitBetween: [payer, payer] }), 'SplitRepeatsAMember'],
          [
            'an account outside the group in the split',
            payer => ({ splitBetween: [payer, 'nobody'] }),
            'MemberNotInGroup',
          ],
        ])('refuses %s with the rule that breaks it, and keeps nothing', async (_label, fieldsFor, rule) => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          const before = (await read(ana.token, id)).body;
          const reply = await edit(ana.token, id, { splitBetween: [ana.id], ...fieldsFor(ana.id) });
          expect(reply.status).toBe(422);
          expect(reply.body).toMatchObject({ error: rule });
          expect((await read(ana.token, id)).body).toEqual(before);
        });

        it('refuses a request with no token, or an unproven one, with 401', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          const body = { description: 'Groceries', amount: 1000, date: utcDay(0), splitBetween: [ana.id], version: 1 };
          expect((await send(app, 'PUT', `/expenses/${id}`, { body })).status).toBe(401);
          expect((await send(app, 'PUT', `/expenses/${id}`, { token: 'not-a-real-token', body })).status).toBe(401);
          expect((await read(ana.token, id)).body).toMatchObject({ version: 1 });
        });

        it('keeps one of two edits made from the same version at once, through two servers, and refuses the other with 409', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const id = await recordOk(ana.token, groupId, [ana.id, ben.id], 1000);
          const second = await startApplication(directory.databasePath);
          try {
            const body = (amount: number) => ({
              description: 'Groceries',
              amount,
              date: utcDay(0),
              splitBetween: [ana.id, ben.id],
              version: 1,
            });
            const [first, other] = await Promise.all([
              send(app, 'PUT', `/expenses/${id}`, { token: ana.token, body: body(700) }),
              send(second, 'PUT', `/expenses/${id}`, { token: ana.token, body: body(800) }),
            ]);
            expect([first.status, other.status].sort()).toEqual([200, 409]);
            const kept = first.status === 200 ? 700 : 800;
            const refused = (first.status === 409 ? first : other).body;
            expect(refused).toMatchObject({ error: 'ExpenseChanged' });
            expect((await read(ana.token, id)).body).toMatchObject({ amount: kept, version: 2 });
            expect(storedCounts()).toEqual({ expenses: 1, shares: 2 });
            const balances = await balancesOf(ana.token, groupId);
            expect(Object.values(balances).reduce((sum, balance) => sum + balance, 0)).toBe(0);
          } finally {
            await second.stop();
          }
        });
      });

      describe('deleting', () => {
        it('deletes the expense as its payer deletes it: it is no longer read, and counts in no balance', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const kept = await recordOk(ana.token, groupId, [ana.id, ben.id], 1000);
          const gone = await recordOk(ben.token, groupId, [ana.id, ben.id], 600);
          const reply = await send(app, 'DELETE', `/expenses/${gone}`, { token: ben.token });
          expect(reply.status).toBe(204);
          expect((await read(ana.token, gone)).status).toBe(404);
          expect(storedCounts()).toEqual({ expenses: 1, shares: 2 });
          expect(await balancesOf(ana.token, groupId)).toEqual(
            expect.objectContaining({ [ana.id]: 500, [ben.id]: -500 }),
          );
          expect((await read(ana.token, kept)).status).toBe(200);
        });

        it('lets the owner delete an expense another member paid', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          const id = await recordOk(ben.token, groupId, [ben.id, ana.id]);
          expect((await send(app, 'DELETE', `/expenses/${id}`, { token: ana.token })).status).toBe(204);
          expect((await read(ben.token, id)).status).toBe(404);
          expect(storedCounts()).toEqual({ expenses: 0, shares: 0 });
        });

        it('refuses a delete by another member who is neither the payer nor the owner, with 403, and keeps the expense', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
          const groupId = await createGroup(ana.token);
          await join(ana.token, groupId, ben.token);
          await join(ana.token, groupId, cleo.token);
          const id = await recordOk(ben.token, groupId, [ben.id, ana.id]);
          const reply = await send(app, 'DELETE', `/expenses/${id}`, { token: cleo.token });
          expect(reply.status).toBe(403);
          expect(reply.body).toMatchObject({ error: 'NotPayerOrOwner' });
          expect((await read(ben.token, id)).status).toBe(200);
        });

        it('answers 404 to an outsider, as if the expense did not exist, and to a second delete of it', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const ben = await signedUpAccount(app, { email: 'ben@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          const outsider = await send(app, 'DELETE', `/expenses/${id}`, { token: ben.token });
          const missing = await send(app, 'DELETE', '/expenses/no-such-expense', { token: ben.token });
          expect(outsider.status).toBe(404);
          expect(outsider.body).toMatchObject({ error: 'ExpenseNotFound' });
          expect(outsider.body).toEqual(missing.body);
          expect((await send(app, 'DELETE', `/expenses/${id}`, { token: ana.token })).status).toBe(204);
          const again = await send(app, 'DELETE', `/expenses/${id}`, { token: ana.token });
          expect(again.status).toBe(404);
          expect(again.body).toMatchObject({ error: 'ExpenseNotFound' });
        });

        it('refuses a request with no token, or an unproven one, with 401, and keeps the expense', async () => {
          const ana = await signedUpAccount(app, { email: 'ana@example.org' });
          const groupId = await createGroup(ana.token);
          const id = await recordOk(ana.token, groupId, [ana.id]);
          expect((await send(app, 'DELETE', `/expenses/${id}`)).status).toBe(401);
          expect((await send(app, 'DELETE', `/expenses/${id}`, { token: 'not-a-real-token' })).status).toBe(401);
          expect((await read(ana.token, id)).status).toBe(200);
        });
      });

      it('upgrades an expense file written before splits by shares or exact amounts: its expenses were split equally', () => {
        const legacyDirectory = testDirectory();
        try {
          const legacy = new DatabaseSync(legacyDirectory.databasePath);
          legacy.exec(`
            CREATE TABLE expenses (
              id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL,
              spent_on TEXT NOT NULL, paid_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
            );
            INSERT INTO expenses VALUES ('old', 'group', 'Groceries', 500, '2026-01-02', 'ana', 3, '2026-01-02T00:00:00.000Z');
          `);
          legacy.close();
          const upgraded = openDatabase(legacyDirectory.databasePath);
          try {
            expect(upgraded.prepare('SELECT split_kind, version FROM expenses WHERE id = ?').get('old')).toEqual({
              split_kind: 'equal',
              version: 3,
            });
          } finally {
            upgraded.close();
          }
        } finally {
          legacyDirectory.remove();
        }
      });

      it('upgrades an expense file written before versions: its expenses are at version 1', () => {
        const legacyDirectory = testDirectory();
        try {
          const legacy = new DatabaseSync(legacyDirectory.databasePath);
          legacy.exec(`
            CREATE TABLE expenses (
              id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL,
              spent_on TEXT NOT NULL, paid_by TEXT NOT NULL, created_at TEXT NOT NULL
            );
            INSERT INTO expenses VALUES ('old', 'group', 'Groceries', 500, '2026-01-02', 'ana', '2026-01-02T00:00:00.000Z');
          `);
          legacy.close();
          const upgraded = openDatabase(legacyDirectory.databasePath);
          try {
            expect(upgraded.prepare('SELECT version FROM expenses WHERE id = ?').get('old')).toMatchObject({
              version: 1,
            });
          } finally {
            upgraded.close();
          }
        } finally {
          legacyDirectory.remove();
        }
      });
    });

    it('keeps an expense and its shares across restarts', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      const id = await recordOk(ana.token, groupId, [ana.id, ben.id], 999);
      const before = await send(app, 'GET', `/expenses/${id}`, { token: ben.token });
      await app.stop();
      db.close();

      app = await startApplication(directory.databasePath);
      db = openDatabase(directory.databasePath);
      const after = await send(app, 'GET', `/expenses/${id}`, { token: ben.token });
      expect(after.body).toEqual(before.body);
    });
  });
});
