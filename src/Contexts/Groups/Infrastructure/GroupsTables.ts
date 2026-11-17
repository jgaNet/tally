import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { createAccountsTable } from '@Contexts/Groups/Infrastructure/AccountsTable';

/**
 * The groups, their members and their invitations, made once by whoever opens the file first; every adapter over them
 * asks for it. A member's row is kept in join order (`position`), so that the owner, the first, is the first row, and
 * with the time it joined. A group's `version` is the one it was last saved at (ADR 8).
 *
 * A member who left keeps its row, with the time it left (`left_at`, ADR 4): a row with no `left_at` is a current member.
 *
 * A file made before the members had their join time and the groups their version is brought up to date here: each
 * member of such a file was the owner, who joined when the group was created.
 */
export function createGroupsTables(database: SqliteDatabase): void {
  createAccountsTable(database);
  database.exec(`CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (group_id, account_id)
  )`);
  database.exec('CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)');
  database.exec(`CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  addColumnUnlessThere(database, 'groups', 'version', 'INTEGER NOT NULL DEFAULT 1');
  addColumnUnlessThere(database, 'group_members', 'joined_at', "TEXT NOT NULL DEFAULT ''");
  addColumnUnlessThere(database, 'group_members', 'left_at', 'TEXT');
  database.exec(`UPDATE group_members SET joined_at = (
    SELECT g.created_at FROM groups g WHERE g.id = group_members.group_id
  ) WHERE joined_at = ''`);
}

function addColumnUnlessThere(database: SqliteDatabase, table: string, column: string, definition: string): void {
  const columns = database.all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some(existing => existing.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
