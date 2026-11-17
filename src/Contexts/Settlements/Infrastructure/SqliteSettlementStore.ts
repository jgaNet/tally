import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettlementStore, SettlementView } from '@Contexts/Settlements/Application/ISettlementStore';
import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * The settlements' tables (feature 12, ADR 10). `settlement_books` is the version each group's book is at: one row per group with a
 * settlement, written with the first one and bumped with each after it, only while the book is still at the version it was read at.
 * `settlements` is one row per recorded settlement, in cash (`method`) and paid (`status`), kept as it was decided; the balances
 * read it through `SqliteSettlementRoster`, so a settlement is counted once it is committed. The group is a group of Groups: the
 * foreign key only names its id, as Ledger's does.
 */
export const settlementsTablesSchema = [
  `CREATE TABLE IF NOT EXISTS settlement_books (
     group_id TEXT PRIMARY KEY REFERENCES groups(id),
     version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settlements (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL REFERENCES groups(id),
     payer_id TEXT NOT NULL,
     payee_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     method TEXT NOT NULL CHECK (method IN ('cash')),
     status TEXT NOT NULL CHECK (status IN ('paid')),
     recorded_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id)',
];

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  recorded_at: string;
}

/**
 * The settlements in SQLite. `save` checks the group's book is still at the version it was read at, and stores the next one with the
 * settlement, in the command's transaction; it refuses a book another writer moved on with a ConcurrencyConflictException (CONC-OPTIMISTIC).
 * `versionOf` and `viewOf` read the committed data.
 */
export class SqliteSettlementStore implements ISettlementStore {
  constructor(private readonly database: SqliteDatabase) {}

  async versionOf(groupId: string): Promise<number> {
    const row = this.database.read(db =>
      db.prepare('SELECT version FROM settlement_books WHERE group_id = ?').get(groupId),
    ) as { version: number } | undefined;
    return row?.version ?? 0;
  }

  async save(book: SettlementBook, settlement: Settlement): Promise<void> {
    this.#checkVersion(book);
    this.database.writer
      .prepare(
        'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        settlement.id,
        settlement.groupId,
        settlement.from,
        settlement.to,
        settlement.amount,
        settlement.method,
        settlement.status,
        settlement.at,
      );
  }

  async viewOf(settlementId: string): Promise<SettlementView | undefined> {
    const row = this.database.read(db => db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId)) as
      SettlementRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      groupId: row.group_id,
      from: row.payer_id,
      to: row.payee_id,
      amount: row.amount,
      method: row.method,
      status: row.status,
      at: row.recorded_at,
    };
  }

  /** Stores the book at its version + 1, only if it is still at the version it was read at; the first settlement creates the row. */
  #checkVersion(book: SettlementBook): void {
    const writer = this.database.writer;
    const { changes } =
      book.version === 0
        ? writer.prepare('INSERT OR IGNORE INTO settlement_books (group_id, version) VALUES (?, 1)').run(book.groupId)
        : writer
            .prepare('UPDATE settlement_books SET version = ? WHERE group_id = ? AND version = ?')
            .run(book.version + 1, book.groupId, book.version);
    if (changes === 0) {
      throw new ConcurrencyConflictException(
        'Settlements',
        'The settlements of the group changed since they were read: read them again',
      );
    }
  }
}
