import { DatabaseSync } from 'node:sqlite';

/** The columns request 13 added to the settlements table, which a database made by request 12 does not have yet. */
const PROVIDER_COLUMNS = ['provider_payment_id', 'pay_url'];

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
          at TEXT NOT NULL,
          provider_payment_id TEXT,
          pay_url TEXT
        );
        CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id);
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
      this.#connection = connection;
    }
    return this.#connection;
  }
}
