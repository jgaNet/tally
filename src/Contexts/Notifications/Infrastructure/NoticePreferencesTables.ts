import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * The notice preferences, in the application's file (request 36): one row per person who ever turned a kind of notice on or off, one
 * flag per kind. A person with no row has every kind on. The owner is unique, so two first changes at once meet on the insert.
 */
export function createNoticePreferencesTables(database: PostgresDatabase): void {
  database.declare(`CREATE TABLE IF NOT EXISTS notice_preferences (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL UNIQUE,
    expense BOOLEAN NOT NULL,
    reminder BOOLEAN NOT NULL,
    budget BOOLEAN NOT NULL,
    version INTEGER NOT NULL
  )`);
}
