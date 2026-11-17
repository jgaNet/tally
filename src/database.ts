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
    left_at    TEXT,
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
    split_kind  TEXT NOT NULL DEFAULT 'equal' CHECK (split_kind IN ('equal', 'exact', 'shares')),
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id TEXT NOT NULL REFERENCES expenses (id),
    position   INTEGER NOT NULL,
    member_id  TEXT NOT NULL REFERENCES accounts (id),
    amount     INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  );
  CREATE TABLE IF NOT EXISTS payout_accounts (
    account_id          TEXT PRIMARY KEY REFERENCES accounts (id),
    provider_account_id TEXT NOT NULL,
    set_at              TEXT NOT NULL
  );
  /*
   * A notice to a member about an expense: written in the transaction that records the expense, so it exists
   * exactly when the expense does. It names the expense without a foreign key: deleting the expense keeps it.
   * One per expense and recipient, whatever happens to the server.
   */
  CREATE TABLE IF NOT EXISTS notices (
    id           TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL REFERENCES accounts (id),
    kind         TEXT NOT NULL CHECK (kind IN ('expense')),
    group_id     TEXT NOT NULL REFERENCES groups (id),
    expense_id   TEXT NOT NULL,
    amount       INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (kind, expense_id, recipient_id)
  );
  CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient_id, created_at);
`;

/**
 * The settlements table. A settlement in cash is `paid` at once; one through the payment provider is `pending`
 * with the provider's payment id and `payUrl`, until the provider says it `paid` or `failed`. A paid one may be
 * `refunding` (asked of the provider) and then `refunded`, as the provider says.
 */
const SETTLEMENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS settlements (
    id                  TEXT PRIMARY KEY,
    group_id            TEXT NOT NULL REFERENCES groups (id),
    payer_id            TEXT NOT NULL REFERENCES accounts (id),
    payee_id            TEXT NOT NULL REFERENCES accounts (id),
    amount              INTEGER NOT NULL CHECK (amount >= 1),
    method              TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
    status              TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
    provider_payment_id TEXT,
    pay_url             TEXT,
    created_at          TEXT NOT NULL,
    CHECK (method = 'provider' OR (status = 'paid' AND provider_payment_id IS NULL AND pay_url IS NULL)),
    CHECK (method = 'cash' OR (provider_payment_id IS NOT NULL AND pay_url IS NOT NULL))
  );
`;

/**
 * Adds the columns a file written before them lacks: `CREATE TABLE IF NOT EXISTS` never alters a
 * table that exists. Runs inside the schema's transaction, so only one server does it.
 */
function addMissingColumns(db: DatabaseSync): void {
  const expenseColumns = db.prepare('PRAGMA table_info(expenses)').all() as unknown as { name: string }[];
  const membershipColumns = db.prepare('PRAGMA table_info(group_members)').all() as unknown as { name: string }[];
  const settlementColumns = db.prepare('PRAGMA table_info(settlements)').all() as unknown as { name: string }[];
  // A membership written before leaving a group has no `left_at`: every such membership is still current.
  if (!membershipColumns.some(column => column.name === 'left_at')) {
    db.exec('ALTER TABLE group_members ADD COLUMN left_at TEXT');
  }
  if (!expenseColumns.some(column => column.name === 'version')) {
    db.exec('ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  // A settlement written before payments through the provider has the old table: its rules (and columns) are
  // rebuilt, its rows kept as they were, each a cash settlement that is paid.
  if (!settlementColumns.some(column => column.name === 'provider_payment_id')) {
    db.exec('ALTER TABLE settlements RENAME TO settlements_before_provider');
    db.exec(SETTLEMENTS_TABLE);
    db.exec(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
       SELECT id, group_id, payer_id, payee_id, amount, method, status, created_at FROM settlements_before_provider`,
    );
    db.exec('DROP TABLE settlements_before_provider');
  }
  // A settlements table written before refunds lacks the statuses they add: its rows are kept as they are.
  const settlementsTable = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settlements'`)
    .get() as { sql: string } | undefined;
  if (settlementsTable && !settlementsTable.sql.includes(`'refunded'`)) {
    db.exec('ALTER TABLE settlements RENAME TO settlements_before_refund');
    db.exec(SETTLEMENTS_TABLE);
    db.exec(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, provider_payment_id, pay_url, created_at)
       SELECT id, group_id, payer_id, payee_id, amount, method, status, provider_payment_id, pay_url, created_at
       FROM settlements_before_refund`,
    );
    db.exec('DROP TABLE settlements_before_refund');
  }
  // An expense written before splits by shares or exact amounts was split equally.
  if (!expenseColumns.some(column => column.name === 'split_kind')) {
    db.exec(
      "ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal' CHECK (split_kind IN ('equal', 'exact', 'shares'))",
    );
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
      db.exec(SETTLEMENTS_TABLE);
      addMissingColumns(db);
      // After the columns exist: an index on a column a file written before lacks would fail.
      db.exec('CREATE INDEX IF NOT EXISTS settlements_by_payment ON settlements (provider_payment_id)');
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
