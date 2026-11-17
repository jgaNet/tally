import { DatabaseSync } from 'node:sqlite';

/**
 * The SQLite file the Groups context keeps its accounts, its groups, its invitations and its signing key in, opened on first
 * use, at the path `pathOf` gives then (`DATABASE_PATH`). Several servers may open the same file: WAL lets them read while one
 * writes, and a busy timeout lets a write wait its turn instead of failing.
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
          created_at TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS expense_group_members (
          group_id TEXT NOT NULL REFERENCES expense_groups (id),
          account_id TEXT NOT NULL,
          joined_at TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (group_id, account_id)
        );
        CREATE INDEX IF NOT EXISTS expense_group_members_by_account ON expense_group_members (account_id);
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL REFERENCES expense_groups (id),
          invited_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      migrate(connection);
      this.#connection = connection;
    }
    return this.#connection;
  }
}

/**
 * Brings a file written by an earlier feature up to this layout (additive, one way). Feature 2 wrote no `joined_at` and no
 * `version`: a group it made is at version 1, and its only membership, the owner's, joined when the group was created.
 */
function migrate(connection: DatabaseSync): void {
  const columnsOf = (table: string) =>
    (connection.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name);

  if (!columnsOf('expense_group_members').includes('joined_at')) {
    connection.exec(`
      ALTER TABLE expense_group_members ADD COLUMN joined_at TEXT NOT NULL DEFAULT '';
      UPDATE expense_group_members SET joined_at = (
        SELECT g.created_at FROM expense_groups g WHERE g.id = expense_group_members.group_id
      ) WHERE joined_at = '';
    `);
  }
  if (!columnsOf('expense_groups').includes('version')) {
    connection.exec('ALTER TABLE expense_groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1;');
  }
}
