import { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite file the Groups context keeps its accounts and its signing key in, opened on first use, at the path
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
