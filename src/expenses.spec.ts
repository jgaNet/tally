import type { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { equalShares } from './expenses';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

describe('expenses', () => {
  describe('splitting equally', () => {
    it('gives the remainder to the payer: 1000 between three, one of them the payer, is 333, 333 and 334', () => {
      expect(equalShares(1000, ['ana', 'ben', 'cleo'], 'cleo')).toEqual([
        { memberId: 'ana', amount: 333 },
        { memberId: 'ben', amount: 333 },
        { memberId: 'cleo', amount: 334 },
      ]);
    });

    it('answers the shares in the order of the split', () => {
      expect(equalShares(1000, ['cleo', 'ben', 'ana'], 'ana').map(share => share.memberId)).toEqual([
        'cleo',
        'ben',
        'ana',
      ]);
    });

    it('gives every member the same share when nothing is left over', () => {
      expect(equalShares(900, ['ana', 'ben', 'cleo'], 'ben')).toEqual([
        { memberId: 'ana', amount: 300 },
        { memberId: 'ben', amount: 300 },
        { memberId: 'cleo', amount: 300 },
      ]);
    });

    it('gives a lone member the whole amount', () => {
      expect(equalShares(4321, ['ana'], 'ana')).toEqual([{ memberId: 'ana', amount: 4321 }]);
    });

    it('makes the shares add up to the amount exactly, each under the payer’s share, whatever the amount and the number', () => {
      const amounts = [1, 2, 3, 7, 99, 100, 101, 999, 1000, 65_537, 99_999_999, 100_000_000];
      for (const amount of amounts) {
        for (let count = 1; count <= 7; count++) {
          const memberIds = Array.from({ length: count }, (_, index) => `m${index}`);
          for (const payer of memberIds) {
            const shares = equalShares(amount, memberIds, payer);
            const total = shares.reduce((sum, share) => sum + share.amount, 0);
            expect(total).toBe(amount);
            expect(shares.every(share => Number.isInteger(share.amount) && share.amount >= 0)).toBe(true);
            const base = Math.floor(amount / count);
            for (const share of shares) {
              if (share.memberId === payer) {
                expect(share.amount - base).toBeLessThan(count);
              } else {
                expect(share.amount).toBe(base);
              }
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
      fields: Partial<{ description: unknown; amount: unknown; date: unknown; splitBetween: unknown }> = {},
    ) {
      return send(app, 'POST', `/groups/${groupId}/expenses`, {
        token,
        body: {
          description: 'Groceries',
          amount: 1000,
          date: utcDay(0),
          splitBetween: [],
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

      it('splits the amount equally, the remainder to the payer, in the order given', async () => {
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
