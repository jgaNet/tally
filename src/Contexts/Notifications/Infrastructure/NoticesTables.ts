import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * The notices, in the application's file, made by whoever prepares the database first. A notice names its recipient, not a group they are in:
 * it is theirs after they leave. Its recording order is its row, which breaks a tie between two made at the same instant. A
 * reminder (ADR 10) has a kind of its own and no expense.
 */
export function createNoticesTables(database: PostgresDatabase): void {
  database.declare(`CREATE TABLE IF NOT EXISTS notices (
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    recipient TEXT NOT NULL,
    group_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'expense',
    expense_id TEXT,
    amount INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    category TEXT,
    month TEXT,
    budget INTEGER
  )`);
  database.declare('CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient, recorded_at)');
}
