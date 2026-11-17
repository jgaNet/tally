import { DatabaseSync } from 'node:sqlite';

import { SqliteFile } from '@Architecture/Infrastructure/DataSources/SqliteFile';

/** The columns request 13 added to the settlements table, which a database made by request 12 does not have yet. */
const PROVIDER_COLUMNS = ['provider_payment_id', 'pay_url'];

/**
 * The SQLite file the Settlements context keeps its settlement books in, opened on first use at the path `pathOf` gives then (ADR
 * 11). It is the application's database file under tables of its own, as Ledger's is (ADR 5), and several servers may open it: WAL
 * lets them read while one writes, and a busy timeout lets a write wait its turn.
 */
export class SettlementsDatabase {
  #ready = false;
  #file?: SqliteFile;

  constructor(private readonly pathOf: () => string) {}

  /** The file the context's rows are in: the one file of the process at that path (ADR 17), whose writes are transactions. */
  get file(): SqliteFile {
    this.#file ??= SqliteFile.of(this.pathOf());
    return this.#file;
  }

  get connection(): DatabaseSync {
    const connection = this.file.connection;
    if (!this.#ready) {
      this.#ready = this.file.schema(connection => {
        connection.exec(`
        CREATE TABLE IF NOT EXISTS settlement_books (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL UNIQUE,
          version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settlements (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          payer TEXT NOT NULL,
          payee TEXT NOT NULL,
          amount INTEGER NOT NULL,
          method TEXT NOT NULL,
          status TEXT NOT NULL,
          at TEXT NOT NULL,
          provider_payment_id TEXT,
          pay_url TEXT
        );
        CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id);
        CREATE TABLE IF NOT EXISTS settlement_history (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          settlement_id TEXT NOT NULL,
          status TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS settlement_history_by_settlement ON settlement_history (settlement_id);
        CREATE TABLE IF NOT EXISTS payout_accounts (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL UNIQUE,
          account_id TEXT NOT NULL,
          version INTEGER NOT NULL
        );
      `);
        // A database request 12 made has the table without the provider's columns: they are added, once, before anything reads them.
        const columns = (connection.prepare('PRAGMA table_info(settlements)').all() as { name: string }[]).map(
          column => column.name,
        );
        for (const column of PROVIDER_COLUMNS) {
          if (!columns.includes(column)) connection.exec(`ALTER TABLE settlements ADD COLUMN ${column} TEXT`);
        }
        connection.exec(
          'CREATE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id)',
        );
        // A settlement stored before its history was kept has no line of it: it gets the one it was recorded with, the only status Tally
        // knows the time of (cash is recorded paid; through the provider, pending). Its later statuses are not known, and are not made up.
        connection.exec(`
        INSERT INTO settlement_history (settlement_id, status, at)
        SELECT id, CASE WHEN method = 'cash' THEN 'paid' ELSE 'pending' END, at FROM settlements
        WHERE id NOT IN (SELECT settlement_id FROM settlement_history);
      `);
      });
    }
    return connection;
  }
}
