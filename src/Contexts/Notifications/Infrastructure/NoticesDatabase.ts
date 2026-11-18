import { DatabaseSync } from 'node:sqlite';

import { SqliteFile } from '@Architecture/Infrastructure/DataSources/SqliteFile';

/**
 * The SQLite file the Notifications context keeps its notices in, opened on first use at the path `pathOf` gives then: the
 * application's database file (`DATABASE_PATH`) under tables of its own (the notices, and the debt watches of request 18), as Ledger and Settlements keep theirs (ADR 5).
 */
export class NoticesDatabase {
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
        // Request 24: a budget's notice names its category, its month and its budget; the others have none.
        if (!columns.some(column => column.name === 'category')) {
          connection.exec(
            'ALTER TABLE notifications_notices ADD COLUMN category TEXT; ALTER TABLE notifications_notices ADD COLUMN month TEXT; ALTER TABLE notifications_notices ADD COLUMN budget INTEGER',
          );
        }
      });
    }
    return connection;
  }
}
