import { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite file the Notifications context keeps its notices in, opened on first use at the path `pathOf` gives then: the
 * application's database file (`DATABASE_PATH`) under tables of its own (the notices, and the debt watches of request 18), as Ledger and Settlements keep theirs (ADR 5).
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
        CREATE TABLE IF NOT EXISTS notifications_debt_watches (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          noted_since TEXT,
          reminded_at TEXT,
          version INTEGER NOT NULL,
          UNIQUE (group_id, member_id)
        );
      `);
      // Request 18 gave a notice its kind; a reminder has no expense, kept as '' (the column was made NOT NULL by request 17).
      const columns = connection.prepare('PRAGMA table_info(notifications_notices)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'kind')) {
        connection.exec("ALTER TABLE notifications_notices ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense'");
      }
      this.#connection = connection;
    }
    return this.#connection;
  }
}
