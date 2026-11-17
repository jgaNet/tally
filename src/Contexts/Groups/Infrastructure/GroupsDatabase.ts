import { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite file the Groups context keeps its accounts, its groups and its signing key in, opened on first use, at the path
 * `pathOf` gives then (`DATABASE_PATH`). Several servers may open the same file: WAL lets them read while one writes,
 * and a busy timeout lets a write wait its turn instead of failing.
 */
export class GroupsDatabase {
  #connection?: DatabaseSync;

  constructor(private readonly pathOf: () => string) {}

  get connection(): DatabaseSync {
    if (!this.#connection) {
      const connection = new DatabaseSync(this.pathOf());
      connection.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          password_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS expense_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          currency TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS expense_group_members (
          group_id TEXT NOT NULL REFERENCES expense_groups (id),
          account_id TEXT NOT NULL,
          PRIMARY KEY (group_id, account_id)
        );
        CREATE INDEX IF NOT EXISTS expense_group_members_by_account ON expense_group_members (account_id);
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      this.#connection = connection;
    }
    return this.#connection;
  }
}
