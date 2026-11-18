import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { SqliteFile } from '@Architecture/Infrastructure/DataSources/SqliteFile';

/**
 * The SQLite file the Groups context keeps its accounts, its groups, its invitations and its signing key in, opened on first
 * use, at the path `pathOf` gives then (`DATABASE_PATH`). Several servers may open the same file: WAL lets them read while one
 * writes, and a busy timeout lets a write wait its turn instead of failing.
 */
export class GroupsDatabase {
  #ready = false;
  #file?: SqliteFile;

  constructor(private readonly pathOf: () => string) {}

  /** The file the groups are in, the one file of the process at that path (ADR 17): its writes are transactions. */
  get file(): SqliteFile {
    this.#file ??= SqliteFile.of(this.pathOf());
    return this.#file;
  }

  get connection(): DatabaseSync {
    const connection = this.file.connection;
    if (!this.#ready) {
      this.#ready = this.file.schema(setUp);
    }
    return connection;
  }
}

/** The tables of the groups, made once, and what a file written by an earlier feature needs (idempotent). */
function setUp(connection: DatabaseSync): void {
  connection.exec(`
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
    CREATE TABLE IF NOT EXISTS expense_group_passes (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL REFERENCES expense_groups (id),
      from_account TEXT NOT NULL,
      to_account TEXT NOT NULL,
      amount INTEGER NOT NULL,
      passed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS expense_group_passes_by_group ON expense_group_passes (group_id);
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
  // The signing key of the access tokens, generated once by the first server that sets the file up, and the same for every server after.
  connection
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('token_key', ?)")
    .run(randomBytes(32).toString('base64url'));
  migrate(connection);
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
  // Request 27: a group archived by its owner keeps when; a group not archived keeps no time (NULL).
  if (!columnsOf('expense_groups').includes('archived_at')) {
    connection.exec('ALTER TABLE expense_groups ADD COLUMN archived_at TEXT;');
  }
}
