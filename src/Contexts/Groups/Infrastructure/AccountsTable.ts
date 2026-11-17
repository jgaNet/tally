import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/** The accounts' table, made once by whoever opens the file first; every adapter over it asks for it. */
export function createAccountsTable(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    version INTEGER NOT NULL
  )`);
}
