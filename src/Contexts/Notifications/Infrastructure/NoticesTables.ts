import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The notices, in the application's file, made by whoever opens it first. A notice names its recipient, not a group they are in:
 * it is theirs after they leave. Its recording order is its row, which breaks a tie between two made at the same instant. A
 * reminder (ADR 10) has a kind of its own and no expense.
 */
export function createNoticesTables(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    group_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'expense',
    expense_id TEXT,
    amount INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
  )`);
  // A file made before reminders had no kind, and its expense_id was required: each of its notices is an expense's, and is kept in
  // the order it was recorded in. The table is rebuilt in place, once.
  const columns = database.all<{ name: string }>('PRAGMA table_info(notices)');
  if (!columns.some(column => column.name === 'kind')) {
    database.exec('ALTER TABLE notices RENAME TO notices_before_reminders');
    database.exec(`CREATE TABLE notices (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      group_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'expense',
      expense_id TEXT,
      amount INTEGER NOT NULL,
      recorded_at TEXT NOT NULL
    )`);
    database.exec(`INSERT INTO notices (id, recipient, group_id, kind, expense_id, amount, recorded_at)
      SELECT id, recipient, group_id, 'expense', expense_id, amount, recorded_at FROM notices_before_reminders ORDER BY rowid`);
    database.exec('DROP TABLE notices_before_reminders');
  }
  // A budget's notice (request 24) names the category, the month and the budget it passed; the others have none.
  if (!database.all<{ name: string }>('PRAGMA table_info(notices)').some(column => column.name === 'category')) {
    database.exec('ALTER TABLE notices ADD COLUMN category TEXT');
    database.exec('ALTER TABLE notices ADD COLUMN month TEXT');
    database.exec('ALTER TABLE notices ADD COLUMN budget INTEGER');
  }
  database.exec('CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient, recorded_at)');
}
