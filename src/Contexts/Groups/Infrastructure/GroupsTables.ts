import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The groups and their members, made once by whoever opens the file first; every adapter over them asks for it. A
 * member's row is kept in join order (`position`), so that the owner, the first, is the first row.
 */
export function createGroupsTables(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (group_id, account_id)
  )`);
  database.exec('CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)');
}
