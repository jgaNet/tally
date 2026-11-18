import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/** The accounts' table, made once by whoever opens the file first; every adapter over it asks for it. */
export function createAccountsTable(database: PostgresDatabase): void {
  database.declare(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    suspended_at TEXT,
    version INTEGER NOT NULL
  )`);
}
