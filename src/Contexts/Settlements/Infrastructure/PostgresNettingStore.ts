import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { INettingStore, NettingView } from '@Contexts/Settlements/Application/INettingStore';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

/**
 * The nettings' tables (feature 32, ADR 27). `nettings` is one row per netting, kept as it was made: who asked, with whom, the currency,
 * the amount, and when. `netting_settlements` names the settlements it made, one row each, in the order they were made (`seq`); the
 * settlements themselves are in `settlements`, which is created first.
 */
export const nettingTablesSchema = [
  `CREATE TABLE IF NOT EXISTS nettings (
     id TEXT PRIMARY KEY,
     by_id TEXT NOT NULL,
     with_id TEXT NOT NULL,
     currency TEXT NOT NULL,
     amount INTEGER NOT NULL,
     recorded_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS netting_settlements (
     netting_id TEXT NOT NULL REFERENCES nettings(id),
     seq INTEGER NOT NULL,
     settlement_id TEXT NOT NULL REFERENCES settlements(id),
     PRIMARY KEY (netting_id, seq)
   )`,
];

interface NettingRow {
  id: string;
  by_id: string;
  with_id: string;
  currency: string;
  amount: number;
}

/**
 * The nettings in PostgreSQL. A netting is written once, in the transaction of the command that decided it, after the settlements it
 * names, so a netting is kept with its settlements or not at all.
 */
export class PostgresNettingStore implements INettingStore {
  constructor(private readonly database: PostgresDatabase) {}

  async save(netting: Netting): Promise<void> {
    const writer = this.database.writer;
    await writer
      .prepare('INSERT INTO nettings (id, by_id, with_id, currency, amount, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(netting.id, netting.by, netting.with, netting.currency, netting.amount, netting.at);
    for (const [seq, settlementId] of netting.settlementIds.entries()) {
      await writer
        .prepare('INSERT INTO netting_settlements (netting_id, seq, settlement_id) VALUES (?, ?, ?)')
        .run(netting.id, seq, settlementId);
    }
  }

  async viewOf(nettingId: string): Promise<NettingView | undefined> {
    const row = (await this.database.read(db => db.prepare('SELECT * FROM nettings WHERE id = ?').get(nettingId))) as
      NettingRow | undefined;
    if (!row) return undefined;
    const lines = (await this.database.read(db =>
      db.prepare('SELECT settlement_id FROM netting_settlements WHERE netting_id = ? ORDER BY seq').all(nettingId),
    )) as { settlement_id: string }[];
    return {
      id: row.id,
      by: row.by_id,
      with: row.with_id,
      currency: row.currency,
      amount: row.amount,
      settlements: lines.map(line => line.settlement_id),
    };
  }
}
