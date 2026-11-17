import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The notices, in the application's file, made by whoever opens it first. A notice names its recipient, not a group they are in:
 * it is theirs after they leave. Its recording order is its row, which breaks a tie between two made at the same instant.
 */
export function createNoticesTables(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    group_id TEXT NOT NULL,
    expense_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
  )`);
  database.exec('CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient, recorded_at)');
}
