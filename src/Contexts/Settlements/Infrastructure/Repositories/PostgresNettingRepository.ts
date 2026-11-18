import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { INettingSnapshot } from '@Contexts/Settlements/Domain/Netting/Netting';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import { INettingRepository } from '@Contexts/Settlements/Domain/Netting/Ports/INettingRepository';

/**
 * The nettings: one row per netting, and one row per settlement it made, in the order they were made (`seq`). Created with the
 * settlements' books, in the transaction of the netting (request 32).
 */
export function createNettingTables(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS nettings (
      id TEXT PRIMARY KEY,
      by_account TEXT NOT NULL,
      with_account TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS netting_settlements (
      seq BIGSERIAL PRIMARY KEY,
      netting_id TEXT NOT NULL,
      settlement_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS netting_settlements_by_netting ON netting_settlements (netting_id);
  `);
}

/** The nettings over the application's PostgreSQL database, inside the transaction of the command. */
export class PostgresNettingRepository implements INettingRepository {
  constructor(private database: PostgresDatabase) {
    createNettingTables(database);
  }

  async save(netting: Netting): Promise<void> {
    const snapshot: INettingSnapshot = netting.toSnapshot();
    await this.database.run(
      'INSERT INTO nettings (id, by_account, with_account, currency, amount) VALUES (?, ?, ?, ?, ?)',
      [snapshot._id, snapshot.by, snapshot.with, snapshot.currency, snapshot.amount],
    );
    for (const settlementId of snapshot.settlements) {
      await this.database.run('INSERT INTO netting_settlements (netting_id, settlement_id) VALUES (?, ?)', [
        snapshot._id,
        settlementId,
      ]);
    }
  }
}
