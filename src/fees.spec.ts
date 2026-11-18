import { type Database, openDatabase } from './database';
import { type Fee, type FeeBearer, payerPartOf, settledAmount, settledSql } from './fees';
import { ensureDatabase, testDirectory, type TestDirectory } from './test-helpers';

describe('what a settlement settles', () => {
  it('is the payer’s part of the fee taken from the amount: the whole fee, half of it rounded down, or none', () => {
    expect(payerPartOf({ amount: 31, borneBy: 'payer' })).toBe(31);
    expect(payerPartOf({ amount: 31, borneBy: 'shared' })).toBe(15);
    expect(payerPartOf({ amount: 30, borneBy: 'shared' })).toBe(15);
    expect(payerPartOf({ amount: 0, borneBy: 'shared' })).toBe(0);
    expect(payerPartOf({ amount: 31, borneBy: 'payee' })).toBe(0);
  });

  it('is its whole amount with no fee, and the amount less the payer’s part with one', () => {
    expect(settledAmount(300, undefined)).toBe(300);
    expect(settledAmount(300, { amount: 31, borneBy: 'payee' })).toBe(300);
    expect(settledAmount(300, { amount: 31, borneBy: 'payer' })).toBe(269);
    expect(settledAmount(300, { amount: 31, borneBy: 'shared' })).toBe(285);
  });

  describe('in the database, as the balances and the statements count it', () => {
    let directory: TestDirectory;
    let db: Database;

    beforeEach(async () => {
      directory = testDirectory();
      await ensureDatabase(directory.databaseUrl);
      db = await openDatabase({ url: directory.databaseUrl });
    });

    afterEach(async () => {
      await db.close();
      await directory.remove();
    });

    it('settles, for every amount and fee and every bearer, what the rule settles', async () => {
      const cases: { amount: number; fee: Fee | undefined }[] = [];
      for (const amount of [1, 2, 300, 100_000]) {
        cases.push({ amount, fee: undefined });
        for (const feeAmount of [0, 1, 2, 31, 30, 299]) {
          if (feeAmount >= amount) continue;
          for (const borneBy of ['payer', 'payee', 'shared'] as FeeBearer[]) {
            cases.push({ amount, fee: { amount: feeAmount, borneBy } });
          }
        }
      }
      const rows = cases
        .map(({ amount, fee }) => {
          const feeAmount = fee === undefined ? 'NULL::bigint' : `${fee.amount}::bigint`;
          const borneBy = fee === undefined ? 'NULL::text' : `'${fee.borneBy}'`;
          return `(${amount}::bigint, ${feeAmount}, ${borneBy})`;
        })
        .join(', ');
      const settled = await db
        .prepare(`SELECT ${settledSql('st')} AS settled FROM (VALUES ${rows}) AS st (amount, fee_amount, fee_borne_by)`)
        .all<{ settled: number }>();
      expect(settled.map(row => Number(row.settled))).toEqual(
        cases.map(({ amount, fee }) => settledAmount(amount, fee)),
      );
    });
  });
});
