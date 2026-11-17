import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

/**
 * The schema, one step per migration. A database's `user_version` says how many steps it has
 * had; a step is only ever appended, never edited.
 */
const migrations: readonly string[] = [
  `
  CREATE TABLE accounts (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    email_key     TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE operations (
    id            TEXT PRIMARY KEY,
    account_id    TEXT REFERENCES accounts (id),
    status        TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'ERROR')),
    result        TEXT,
    error_type    TEXT,
    error_message TEXT,
    created_at    TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    currency   TEXT NOT NULL CHECK (currency IN ('EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD')),
    owner_id   TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE memberships (
    group_id   TEXT NOT NULL REFERENCES groups (id),
    account_id TEXT NOT NULL REFERENCES accounts (id),
    joined_at  TEXT NOT NULL,
    PRIMARY KEY (group_id, account_id)
  );
  CREATE INDEX memberships_by_account ON memberships (account_id);
  `,
];

/** Runs `work` under one write lock: its writes all land, or none does. */
export function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Opens the SQLite file at `path` (or a private in-memory database for `:memory:`), makes sure
 * it is in WAL mode so several servers can share it, and brings its schema up to date.
 */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000');
  if (path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    // FULL: a committed write survives the power going, not only the process being stopped.
    db.exec('PRAGMA synchronous = FULL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  // Several servers may start on the same file at once: the check and the steps run under one
  // write lock, and each server re-reads the version once it holds it.
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    for (let step = current; step < migrations.length; step++) {
      db.exec(migrations[step]);
    }
    if (current < migrations.length) {
      db.exec(`PRAGMA user_version = ${migrations.length}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
