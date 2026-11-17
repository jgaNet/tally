import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The schema, one entry per version: entry `n` takes the database from version `n` to `n + 1`.
 * Only ever append to this list.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );
  CREATE UNIQUE INDEX accounts_email ON accounts (email);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    account_id TEXT REFERENCES accounts (id),
    status TEXT NOT NULL,
    result TEXT,
    error_type TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL
  );
  `,
];

/**
 * Opens (creating it if needed) the SQLite file at `path` and brings its schema up to date. Several
 * servers may open the same file: it runs in WAL mode, waits for a lock instead of failing on it, and
 * migrates inside a write transaction so two starting servers cannot both apply a migration.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let version = current; version < MIGRATIONS.length; version++) {
      db.exec(MIGRATIONS[version]);
    }
    if (current < MIGRATIONS.length) db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
