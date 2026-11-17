import { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite file the Settlements context keeps its settlement books in, opened on first use at the path `pathOf` gives then (ADR
 * 11). It is the application's database file under tables of its own, as Ledger's is (ADR 5), and several servers may open it: WAL
 * lets them read while one writes, and a busy timeout lets a write wait its turn.
 */
export class SettlementsDatabase {
  #connection?: DatabaseSync;

  constructor(private readonly pathOf: () => string) {}

  get connection(): DatabaseSync {
    if (!this.#connection) {
      const connection = new DatabaseSync(this.pathOf());
      connection.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
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
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id);
      `);
      this.#connection = connection;
    }
    return this.#connection;
  }
}
