import { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite file the Notifications context keeps its notices in, opened on first use at the path `pathOf` gives then: the
 * application's database file (`DATABASE_PATH`) under a table of its own, as Ledger and Settlements keep theirs (ADR 5).
 */
export class NoticesDatabase {
  #connection?: DatabaseSync;

  constructor(private readonly pathOf: () => string) {}

  get connection(): DatabaseSync {
    if (!this.#connection) {
      const connection = new DatabaseSync(this.pathOf());
      connection.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS notifications_notices (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          member_id TEXT NOT NULL,
          group_id TEXT NOT NULL,
          expense_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS notifications_notices_by_member ON notifications_notices (member_id);
      `);
      this.#connection = connection;
    }
    return this.#connection;
  }
}
