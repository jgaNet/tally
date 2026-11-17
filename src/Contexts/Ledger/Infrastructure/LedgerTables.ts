import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The expenses and their shares, in the application's file, made by whoever opens it first. An expense's `version` is the
 * one it was last saved at: 1 when recorded, one more at each edit (ADR 8). Its `split_kind` is how it was split: equally,
 * by exact amounts or by shares; an expense kept before splits had kinds was split equally. Its shares are kept in the order
 * the split was given (`position`); an edit replaces them, and a deletion removes the expense and them.
 */
export function createLedgerTables(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    spent_on TEXT NOT NULL,
    paid_by TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    split_kind TEXT NOT NULL DEFAULT 'equal',
    recorded_seq INTEGER NOT NULL DEFAULT 0
  )`);
  // A file made before expenses had a version: each of them is at version 1, the one it was recorded at. A file made before
  // splits had kinds: each of them was split equally. A file made before expenses had a recording order: each is ordered by
  // the position it was stored at, which is the order it was recorded in.
  const columns = database.all<{ name: string }>('PRAGMA table_info(expenses)');
  if (!columns.some(column => column.name === 'version')) {
    database.exec('ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.some(column => column.name === 'split_kind')) {
    database.exec("ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'");
  }
  if (!columns.some(column => column.name === 'recorded_seq')) {
    database.exec('ALTER TABLE expenses ADD COLUMN recorded_seq INTEGER NOT NULL DEFAULT 0');
    database.exec('UPDATE expenses SET recorded_seq = rowid');
  }
  database.exec('CREATE INDEX IF NOT EXISTS expenses_by_group ON expenses (group_id)');
  database.exec(`CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  )`);
  // The balances: a read model of the expenses, each one counted in the transaction that stores it (T4). A row is a
  // member's balance in a group; a member with nothing counted has no row, and reads as 0.
  database.exec(`CREATE TABLE IF NOT EXISTS member_balances (
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    balance INTEGER NOT NULL,
    PRIMARY KEY (group_id, member_id)
  )`);
}
