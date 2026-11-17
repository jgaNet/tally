import { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite file the Ledger context keeps its expenses in, opened on first use at the path `pathOf` gives then. It is
 * the application's database file, under tables of its own (ADR 5), and several servers may open it: WAL lets them read
 * while one writes, and a busy timeout lets a write wait its turn.
 */
export class LedgerDatabase {
  #connection?: DatabaseSync;

  constructor(private readonly pathOf: () => string) {}

  get connection(): DatabaseSync {
    if (!this.#connection) {
      const connection = new DatabaseSync(this.pathOf());
      connection.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS ledger_expenses (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          description TEXT NOT NULL,
          amount INTEGER NOT NULL,
          date TEXT NOT NULL,
          paid_by TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ledger_expenses_by_group ON ledger_expenses (group_id);
        CREATE TABLE IF NOT EXISTS ledger_expense_shares (
          expense_id TEXT NOT NULL REFERENCES ledger_expenses (id),
          position INTEGER NOT NULL,
          member_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          PRIMARY KEY (expense_id, position)
        );
      `);
      this.#connection = connection;
    }
    return this.#connection;
  }
}
