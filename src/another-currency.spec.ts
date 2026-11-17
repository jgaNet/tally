import { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { convertedAmount } from './expenses';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

describe('an expense in another currency', () => {
  describe('converting the original amount', () => {
    it('rounds 1234 at 1.0625 (1311.125) down to 1311', () => {
      expect(convertedAmount(1234, '1.0625')).toBe(1311);
    });

    it('rounds 1000 at 0.9545 (954.5) up to 955: a half is rounded up', () => {
      expect(convertedAmount(1000, '0.9545')).toBe(955);
    });

    it('rounds a half up whatever the rate: 1 at 0.5 is 1, and 2 at 0.25 is 1', () => {
      expect(convertedAmount(1, '0.5')).toBe(1);
      expect(convertedAmount(2, '0.25')).toBe(1);
    });

    it('is exact where a binary float is not: 1000 at 1.005 is 1005', () => {
      expect(convertedAmount(1000, '1.005')).toBe(1005);
    });

    it('keeps the amount at a rate of 1, and reads rates written as whole numbers or with 6 digits after the point', () => {
      expect(convertedAmount(777, '1')).toBe(777);
      expect(convertedAmount(2, '12.5')).toBe(25);
      expect(convertedAmount(100_000_000, '0.000001')).toBe(100);
    });
  });

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

  /** Creates a group in `currency` as `token`'s account and answers its id. */
  async function createGroup(token: string, currency = 'EUR'): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Flat', currency } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes the account of `joinerToken` a member of `groupId`, through an invitation its owner creates. */
  async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
    const id = (invitation.body as { id: string }).id;
    const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: joinerToken });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
  }

  /**
   * The body of an expense of 1234 francs at 1.0625 (1311 euros in a euro group), on today, split equally between
   * `ids`; `fields` override it.
   */
  function bodyOf(ids: string[], fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      description: 'Dinner',
      date: utcDay(0),
      original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      splitBetween: ids,
      ...fields,
    };
  }

  /** Records an expense in `groupId` as `token`'s account, with `body`. */
  async function record(token: string, groupId: string, body: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, { token, body });
  }

  /** Records an expense with `body`, which must be accepted; answers its id. */
  async function recordOk(token: string, groupId: string, body: Record<string, unknown>): Promise<string> {
    const reply = await record(token, groupId, body);
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  async function read(token: string, id: string) {
    return send(app, 'GET', `/expenses/${id}`, { token });
  }

  async function balancesOf(token: string, groupId: string): Promise<Record<string, number>> {
    const reply = await send(app, 'GET', `/groups/${groupId}/balances`, { token });
    const balances = reply.body as { memberId: string; balance: number }[];
    return Object.fromEntries(balances.map(balance => [balance.memberId, balance.balance]));
  }

  /** How many expenses the file holds, read on the second connection. */
  function storedExpenses(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number }).n;
  }

  describe('recording', () => {
    it('records the expense at the amount in the group’s currency: 1234 francs at 1.0625 is 1311 euros', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      const reply = await record(ana.token, groupId, bodyOf([ana.id, ben.id]));
      expect(reply.status).toBe(201);
      const expense = await read(ana.token, (reply.body as { id: string }).id);
      expect(expense.status).toBe(200);
      expect(expense.body).toMatchObject({
        amount: 1311,
        original: { currency: 'CHF', amount: 1234, rate: '1.0625' },
      });
    });

    it('splits the amount in the group’s currency, not the original: 1311 between two is 656 for the payer and 655 for the other', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      const id = await recordOk(ana.token, groupId, bodyOf([ana.id, ben.id]));
      expect((await read(ben.token, id)).body).toMatchObject({
        shares: [
          { memberId: ana.id, amount: 656 },
          { memberId: ben.id, amount: 655 },
        ],
      });
    });

    it('keeps the rate as it was given, the same string: "1", "12.5" and "0.9542" read back as written', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      for (const rate of ['1', '12.5', '0.9542']) {
        const id = await recordOk(
          ana.token,
          groupId,
          bodyOf([ana.id], { original: { currency: 'USD', amount: 1000, rate } }),
        );
        expect((await read(ana.token, id)).body).toMatchObject({ original: { currency: 'USD', rate } });
      }
    });

    it('keeps the currency and the original amount it was given with', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordOk(
        ana.token,
        groupId,
        bodyOf([ana.id], { original: { currency: 'GBP', amount: 1000, rate: '0.8' } }),
      );
      const expense = (await read(ana.token, id)).body as Record<string, unknown>;
      expect(expense.amount).toBe(800);
      expect(expense.original).toEqual({ currency: 'GBP', amount: 1000, rate: '0.8' });
    });

    it('reads an expense in the group’s currency without an original, as before', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordOk(ana.token, groupId, {
        description: 'Dinner',
        amount: 1000,
        date: utcDay(0),
        splitBetween: [ana.id],
      });
      const expense = (await read(ana.token, id)).body as Record<string, unknown>;
      expect(expense).toMatchObject({ amount: 1000 });
      expect(expense).not.toHaveProperty('original');
    });

    it('counts the converted amount in the balances and in the statement of the payer', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      await recordOk(ana.token, groupId, bodyOf([ana.id, ben.id]));
      expect(await balancesOf(ana.token, groupId)).toEqual({ [ana.id]: 655, [ben.id]: -655 });
      const statement = await send(app, 'GET', `/groups/${groupId}/members/${ana.id}/statement`, { token: ana.token });
      expect(statement.body).toMatchObject({
        balance: 655,
        entries: [{ paid: 1311, share: 656, balance: 655 }],
      });
    });

    it('splits by exact amounts in the group’s currency: they add up to 1311, not to the original 1234', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      const exact = bodyOf([], {
        splitBetween: undefined,
        splitExactly: [
          { memberId: ana.id, amount: 1000 },
          { memberId: ben.id, amount: 311 },
        ],
      });
      const id = await recordOk(ana.token, groupId, exact);
      expect((await read(ana.token, id)).body).toMatchObject({
        amount: 1311,
        splitKind: 'exact',
        shares: [
          { memberId: ana.id, amount: 1000 },
          { memberId: ben.id, amount: 311 },
        ],
      });

      const notConverted = bodyOf([], {
        splitBetween: undefined,
        splitExactly: [
          { memberId: ana.id, amount: 1000 },
          { memberId: ben.id, amount: 234 },
        ],
      });
      const refused = await record(ana.token, groupId, notConverted);
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ error: 'AmountsDoNotAddUp' });
    });

    it('splits by shares of the converted amount: 1311 by shares of 2 and 1 is 874 and 437', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      const id = await recordOk(
        ana.token,
        groupId,
        bodyOf([], {
          splitBetween: undefined,
          splitByShares: [
            { memberId: ana.id, shares: 2 },
            { memberId: ben.id, shares: 1 },
          ],
        }),
      );
      expect((await read(ana.token, id)).body).toMatchObject({
        splitKind: 'shares',
        shares: [
          { memberId: ana.id, amount: 874 },
          { memberId: ben.id, amount: 437 },
        ],
      });
    });

    it('answers the expense as it was recorded, across a restart of the server', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordOk(
        ana.token,
        groupId,
        bodyOf([ana.id], { original: { currency: 'USD', amount: 7, rate: '0.9542' } }),
      );
      const before = await read(ana.token, id);
      await app.stop();
      db.close();
      app = await startApplication(directory.databasePath);
      db = openDatabase(directory.databasePath);
      expect((await read(ana.token, id)).body).toEqual(before.body);
    });

    describe('refusing', () => {
      it('refuses a body with neither amount nor original, or with both, with 400, and stores nothing', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const bodies = [bodyOf([ana.id], { original: undefined }), bodyOf([ana.id], { amount: 1000 })];
        for (const body of bodies) {
          expect((await record(ana.token, groupId, body)).status).toBe(400);
        }
        expect(storedExpenses()).toBe(0);
      });

      it('refuses an original with a missing field or a field of the wrong type, with 400', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const originals: unknown[] = [
          { currency: 'CHF', amount: 1234 },
          { currency: 'CHF', rate: '1.0625' },
          { amount: 1234, rate: '1.0625' },
          { currency: 'CHF', amount: '1234', rate: '1.0625' },
          { currency: 'CHF', amount: 1234, rate: 1.0625 },
          'CHF 1234',
        ];
        for (const original of originals) {
          expect((await record(ana.token, groupId, bodyOf([ana.id], { original }))).status).toBe(400);
        }
        expect(storedExpenses()).toBe(0);
      });

      it('refuses the group’s own currency as the other one, and a currency that is not Tally’s, with 422', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token, 'EUR');
        const sameAsGroup = await record(
          ana.token,
          groupId,
          bodyOf([ana.id], { original: { currency: 'EUR', amount: 1234, rate: '1' } }),
        );
        expect(sameAsGroup.status).toBe(422);
        expect(sameAsGroup.body).toMatchObject({ error: 'CurrencyIsTheGroupsCurrency' });
        const unknown = await record(
          ana.token,
          groupId,
          bodyOf([ana.id], { original: { currency: 'JPY', amount: 1234, rate: '1' } }),
        );
        expect(unknown.status).toBe(422);
        expect(unknown.body).toMatchObject({ error: 'CurrencyIsUnsupported' });
        expect(storedExpenses()).toBe(0);
      });

      it('refuses an original amount that is not a whole number from 1 to 100 000 000, with 422', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        for (const amount of [0, -5, 1.5, 100_000_001]) {
          const reply = await record(
            ana.token,
            groupId,
            bodyOf([ana.id], { original: { currency: 'CHF', amount, rate: '1' } }),
          );
          expect(reply.status).toBe(422);
          expect(reply.body).toMatchObject({ error: 'OriginalAmountIsInvalid' });
        }
        expect(storedExpenses()).toBe(0);
      });

      it('refuses a rate that is not a decimal number greater than 0 with at most 6 digits after the point, with 422', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        for (const rate of ['0', '0.000000', '-1', '1.0000001', '1e3', '.5', '', 'abc']) {
          const reply = await record(
            ana.token,
            groupId,
            bodyOf([ana.id], { original: { currency: 'CHF', amount: 1234, rate } }),
          );
          expect(reply.status).toBe(422);
          expect(reply.body).toMatchObject({ error: 'RateIsInvalid' });
        }
        expect(storedExpenses()).toBe(0);
      });

      it('refuses an amount that converts to less than 1 or more than 100 000 000 in the group’s currency, with 422', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const tooSmall = await record(
          ana.token,
          groupId,
          bodyOf([ana.id], { original: { currency: 'CHF', amount: 1, rate: '0.4' } }),
        );
        expect(tooSmall.status).toBe(422);
        expect(tooSmall.body).toMatchObject({ error: 'AmountIsInvalid' });
        const tooLarge = await record(
          ana.token,
          groupId,
          bodyOf([ana.id], { original: { currency: 'CHF', amount: 100_000_000, rate: '1.5' } }),
        );
        expect(tooLarge.status).toBe(422);
        expect(tooLarge.body).toMatchObject({ error: 'AmountIsInvalid' });
        expect(storedExpenses()).toBe(0);
      });

      it('accepts an original of 1 at a rate that converts it to 1, the least amount', async () => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const groupId = await createGroup(ana.token);
        const reply = await record(
          ana.token,
          groupId,
          bodyOf([ana.id], { original: { currency: 'CHF', amount: 1, rate: '1' } }),
        );
        expect(reply.status).toBe(201);
        expect((await read(ana.token, (reply.body as { id: string }).id)).body).toMatchObject({ amount: 1 });
      });
    });
  });

  describe('editing', () => {
    /** An expense in another currency, recorded by `token`'s account at version 1; answers its id. */
    async function recordInFrancs(token: string, groupId: string, ownId: string): Promise<string> {
      return recordOk(token, groupId, bodyOf([ownId]));
    }

    /** Edits the expense `id` as `token`'s account, from `version`, with `fields` replacing the valid body. */
    async function edit(token: string, id: string, fields: Record<string, unknown>, version = 1) {
      return send(app, 'PUT', `/expenses/${id}`, { token, body: { version, ...fields } });
    }

    it('edits an expense in the group’s currency into one in another, at the next version, and the balances follow', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      const id = await recordOk(ana.token, groupId, {
        description: 'Dinner',
        amount: 1000,
        date: utcDay(0),
        splitBetween: [ana.id, ben.id],
      });
      const reply = await edit(ana.token, id, {
        description: 'Dinner',
        date: utcDay(0),
        original: { currency: 'USD', amount: 500, rate: '0.9542' },
        splitBetween: [ana.id, ben.id],
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        version: 2,
        amount: 477,
        original: { currency: 'USD', amount: 500, rate: '0.9542' },
      });
      // 477 is split 239 for the payer (the remainder goes to the first member listed) and 238: the payer is owed 238.
      expect(await balancesOf(ana.token, groupId)).toEqual({ [ana.id]: 238, [ben.id]: -238 });
    });

    it('edits an expense in another currency back into the group’s currency, which then reads without an original', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordInFrancs(ana.token, groupId, ana.id);
      const reply = await edit(ana.token, id, {
        description: 'Dinner',
        date: utcDay(0),
        amount: 900,
        splitBetween: [ana.id],
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ version: 2, amount: 900 });
      expect(reply.body).not.toHaveProperty('original');
      expect((await read(ana.token, id)).body).not.toHaveProperty('original');
    });

    it('keeps the rate it is edited with as the string given, and edits from the version read', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordInFrancs(ana.token, groupId, ana.id);
      const reply = await edit(
        ana.token,
        id,
        {
          description: 'Dinner',
          date: utcDay(0),
          original: { currency: 'CHF', amount: 1000, rate: '12.5' },
          splitBetween: [ana.id],
        },
        1,
      );
      expect(reply.body).toMatchObject({ amount: 12500, original: { currency: 'CHF', amount: 1000, rate: '12.5' } });
      const stale = await edit(
        ana.token,
        id,
        { description: 'Dinner', date: utcDay(0), amount: 5, splitBetween: [ana.id] },
        1,
      );
      expect(stale.status).toBe(409);
    });

    it('refuses an edit with neither amount nor original, or with both, with 400, and keeps the expense', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordInFrancs(ana.token, groupId, ana.id);
      const base = { description: 'Dinner', date: utcDay(0), splitBetween: [ana.id] };
      const neither = await edit(ana.token, id, base);
      const both = await edit(ana.token, id, {
        ...base,
        amount: 1000,
        original: { currency: 'USD', amount: 1000, rate: '1' },
      });
      expect(neither.status).toBe(400);
      expect(both.status).toBe(400);
      expect((await read(ana.token, id)).body).toMatchObject({ version: 1, amount: 1311 });
    });

    it('refuses an edit into the group’s own currency or with a bad rate, with 422, and keeps the expense as it was', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      const id = await recordInFrancs(ana.token, groupId, ana.id);
      const before = await read(ana.token, id);
      const sameAsGroup = await edit(ana.token, id, {
        description: 'Dinner',
        date: utcDay(0),
        original: { currency: 'EUR', amount: 1234, rate: '1' },
        splitBetween: [ana.id],
      });
      expect(sameAsGroup.status).toBe(422);
      expect(sameAsGroup.body).toMatchObject({ error: 'CurrencyIsTheGroupsCurrency' });
      const badRate = await edit(ana.token, id, {
        description: 'Dinner',
        date: utcDay(0),
        original: { currency: 'USD', amount: 1234, rate: '0' },
        splitBetween: [ana.id],
      });
      expect(badRate.status).toBe(422);
      expect(badRate.body).toMatchObject({ error: 'RateIsInvalid' });
      expect((await read(ana.token, id)).body).toEqual(before.body);
    });
  });

  it('upgrades an expense file written before expenses in another currency: its expenses are in the group’s currency', () => {
    const legacyDirectory = testDirectory();
    try {
      const legacy = new DatabaseSync(legacyDirectory.databasePath);
      legacy.exec(`
        CREATE TABLE expenses (
          id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL,
          spent_on TEXT NOT NULL, paid_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
          split_kind TEXT NOT NULL DEFAULT 'equal', created_at TEXT NOT NULL
        );
        INSERT INTO expenses VALUES ('old', 'group', 'Groceries', 500, '2026-01-02', 'ana', 1, 'equal', '2026-01-02T00:00:00.000Z');
      `);
      legacy.close();
      const upgraded = openDatabase(legacyDirectory.databasePath);
      try {
        expect(
          upgraded
            .prepare('SELECT amount, original_currency, original_amount, rate FROM expenses WHERE id = ?')
            .get('old'),
        ).toEqual({ amount: 500, original_currency: null, original_amount: null, rate: null });
      } finally {
        upgraded.close();
      }
    } finally {
      legacyDirectory.remove();
    }
  });
});
