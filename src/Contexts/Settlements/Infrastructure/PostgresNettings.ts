import { PostgresDatabase, Setup } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { NettingView } from '@Contexts/Settlements/Domain/Netting/DTOs';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import { INettings } from '@Contexts/Settlements/Domain/Netting/Ports/INettings';
import { INettingQueries } from '@Contexts/Settlements/Domain/Netting/Ports/INettingQueries';

/**
 * The tables of the nettings (docs/adr/0032): a netting is a row, and its settlements are rows of their own, numbered by the position
 * they were made in. Written once, never changed.
 */
export const prepareNettingSchema: Setup = async database => {
  await database.exec(
    'CREATE TABLE IF NOT EXISTS nettings (id TEXT PRIMARY KEY, by_id TEXT NOT NULL, with_id TEXT NOT NULL, currency TEXT NOT NULL, amount INTEGER NOT NULL)',
  );
  await database.exec(
    'CREATE TABLE IF NOT EXISTS netting_settlements (netting_id TEXT NOT NULL, position INTEGER NOT NULL, settlement_id TEXT NOT NULL, PRIMARY KEY (netting_id, position))',
  );
};

/** The nettings' store over PostgreSQL. Its methods run inside the netting's transaction, with the books it stores (docs/adr/0032). */
export class PostgresNettings implements INettings {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareNettingSchema);
  }

  async save(netting: Netting): Promise<void> {
    this.database.assertInTransaction();
    await this.database.run('INSERT INTO nettings (id, by_id, with_id, currency, amount) VALUES (?, ?, ?, ?, ?)', [
      netting.id,
      netting.by,
      netting.with,
      netting.currency,
      netting.amount,
    ]);
    for (const [position, settlementId] of netting.settlements.entries()) {
      await this.database.run(
        'INSERT INTO netting_settlements (netting_id, position, settlement_id) VALUES (?, ?, ?)',
        [netting.id, position, settlementId],
      );
    }
  }
}

/** The nettings' read side over PostgreSQL: what `GetNetting` answers (request 32). */
export class PostgresNettingQueries implements INettingQueries {
  constructor(private readonly database: PostgresDatabase) {}

  async findNetting(nettingId: string): Promise<NettingView | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{
        id: string;
        by_id: string;
        with_id: string;
        currency: string;
        amount: number;
      }>('SELECT id, by_id, with_id, currency, amount FROM nettings WHERE id = ?', [nettingId]);
      if (!row) return undefined;
      const settlements = await this.database.all<{ settlement_id: string }>(
        'SELECT settlement_id FROM netting_settlements WHERE netting_id = ? ORDER BY position',
        [nettingId],
      );
      return {
        id: String(row.id),
        by: String(row.by_id),
        with: String(row.with_id),
        currency: String(row.currency),
        amount: Number(row.amount),
        settlements: settlements.map(each => String(each.settlement_id)),
      };
    });
  }
}
