import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/** The debt watches, in the application's file (ADR 10): one per member and group, so that two sweeps at once meet on one row. */
export function createDebtWatchTables(database: PostgresDatabase): void {
  database.declare(`CREATE TABLE IF NOT EXISTS debt_watches (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    noted_since TEXT,
    reminded_at TEXT,
    version INTEGER NOT NULL,
    UNIQUE (group_id, member_id)
  )`);
  database.declare('CREATE INDEX IF NOT EXISTS debt_watches_noted ON debt_watches (noted_since)');
}
