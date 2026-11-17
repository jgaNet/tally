import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The expenses and their shares, in the application's file, made by whoever opens it first. An expense is written once
 * and never changed; its shares are kept in the order the split was given (`position`).
 */
export function createLedgerTables(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    spent_on TEXT NOT NULL,
    paid_by TEXT NOT NULL
  )`);
  database.exec('CREATE INDEX IF NOT EXISTS expenses_by_group ON expenses (group_id)');
  database.exec(`CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  )`);
}
