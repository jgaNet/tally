import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The schema, created when missing. Every table is created with `IF NOT EXISTS`, so several
 * servers may start on the same file in turn or together.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    email_key     TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS operations (
    id            TEXT PRIMARY KEY,
    status        TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'ERROR')),
    result        TEXT,
    error_type    TEXT,
    error_message TEXT,
    account_id    TEXT REFERENCES accounts (id),
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    currency   TEXT NOT NULL CHECK (currency IN ('EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD')),
    owner_id   TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id   TEXT NOT NULL REFERENCES groups (id),
    account_id TEXT NOT NULL REFERENCES accounts (id),
    joined_at  TEXT NOT NULL,
    PRIMARY KEY (group_id, account_id)
  );
  CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id);
  CREATE TABLE IF NOT EXISTS invitations (
    id         TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL REFERENCES groups (id),
    created_by TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups (id),
    description TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    spent_on    TEXT NOT NULL,
    paid_by     TEXT NOT NULL REFERENCES accounts (id),
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id TEXT NOT NULL REFERENCES expenses (id),
    position   INTEGER NOT NULL,
    member_id  TEXT NOT NULL REFERENCES accounts (id),
    amount     INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  );
`;

/**
 * Adds the columns a file written before them lacks: `CREATE TABLE IF NOT EXISTS` never alters a
 * table that exists. Runs inside the schema's transaction, so only one server does it.
 */
function addMissingColumns(db: DatabaseSync): void {
  const expenseColumns = db.prepare('PRAGMA table_info(expenses)').all() as unknown as { name: string }[];
  if (!expenseColumns.some(column => column.name === 'version')) {
    db.exec('ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
}

/** How long a connection waits for another server's write lock before it fails, in milliseconds. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Opens (creating if needed) the SQLite database at `path`. Writes are durable before they are
 * answered (`synchronous = FULL` in write-ahead mode), so a server killed at any moment and
 * started again on the same file finds everything it had answered for.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    // Serialises the schema creation across servers sharing the file.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(SCHEMA);
      addMissingColumns(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * True when `error` is SQLite refusing a row that repeats a unique key. Checked by shape: errors from
 * the SQLite binding do not always pass `instanceof Error` (the test runner's realm differs).
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('UNIQUE constraint failed')
  );
}
