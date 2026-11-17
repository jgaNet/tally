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
    balance_base INTEGER NOT NULL DEFAULT 0,
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
    original_currency TEXT,
    original_amount   INTEGER,
    rate              TEXT,
    recurring_id      TEXT,
    recurring_day     TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id TEXT NOT NULL REFERENCES expenses (id),
    position   INTEGER NOT NULL,
    member_id  TEXT NOT NULL REFERENCES accounts (id),
    amount     INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  );
  /*
   * A recurring expense, with its split as given (one row per member in recurring_parts: the amount of an exact
   * split, the shares of a split by shares, nothing for an equal one). next_on is the day of the next expense to
   * record; it moves in the transaction that records the expense.
   */
  CREATE TABLE IF NOT EXISTS recurring (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups (id),
    paid_by     TEXT NOT NULL REFERENCES accounts (id),
    description TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    starts_on   TEXT NOT NULL,
    next_on     TEXT NOT NULL,
    split_kind  TEXT NOT NULL CHECK (split_kind IN ('equal', 'exact', 'shares')),
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recurring_parts (
    recurring_id TEXT NOT NULL REFERENCES recurring (id),
    position     INTEGER NOT NULL,
    member_id    TEXT NOT NULL REFERENCES accounts (id),
    value        INTEGER,
    PRIMARY KEY (recurring_id, position)
  );
  CREATE TABLE IF NOT EXISTS payout_accounts (
    account_id          TEXT PRIMARY KEY REFERENCES accounts (id),
    provider_account_id TEXT NOT NULL,
    set_at              TEXT NOT NULL
  );
  /*
   * The debts the background job watches: a member it saw owing more than the reminder threshold in a group,
   * since noted_at, and when it last reminded them. A member seen owing less is no longer watched.
   */
  CREATE TABLE IF NOT EXISTS lasting_debts (
    group_id         TEXT NOT NULL REFERENCES groups (id),
    account_id       TEXT NOT NULL REFERENCES accounts (id),
    noted_at         TEXT NOT NULL,
    last_reminded_at TEXT,
    PRIMARY KEY (group_id, account_id)
  );
`;

/**
 * A notice to a member. One about an expense is written in the transaction that records the expense, so it exists
 * exactly when the expense does; it names the expense without a foreign key: deleting the expense keeps it. One
 * per expense and recipient, whatever happens to the server. A reminder (of a lasting debt) has no expense.
 */
const NOTICES_TABLE = `
  CREATE TABLE IF NOT EXISTS notices (
    id           TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL REFERENCES accounts (id),
    kind         TEXT NOT NULL CHECK (kind IN ('expense', 'reminder')),
    group_id     TEXT NOT NULL REFERENCES groups (id),
    expense_id   TEXT,
    amount       INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    CHECK ((kind = 'expense') = (expense_id IS NOT NULL)),
    UNIQUE (kind, expense_id, recipient_id)
  );
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
 * Every status a settlement has had, one row per change, in the order they were learned (the rows' order). A row is
 * written in the transaction that changes the settlement, so the history exists exactly when the change does.
 */
const SETTLEMENT_STATUSES_TABLE = `
  CREATE TABLE IF NOT EXISTS settlement_statuses (
    settlement_id TEXT NOT NULL REFERENCES settlements (id),
    status        TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
    at            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS settlement_statuses_by_settlement ON settlement_statuses (settlement_id);
`;

/**
 * The statuses a settlement of a file written before its history was kept had, in order, each at the time the
 * settlement was recorded: the file does not say when they changed. A cash settlement was `paid`. A provider one was
 * `pending`, and was `paid` before a refund (`refunding`), and it is its status now unless that is `pending`.
 */
function statusesBeforeHistory(row: { method: string; status: string }): string[] {
  if (row.method === 'cash') return [row.status];
  const statuses = ['pending'];
  if (row.status === 'refunding') statuses.push('paid');
  if (row.status !== 'pending') statuses.push(row.status);
  return statuses;
}

/** Writes the history of the settlements a file written before it has, from what they are now. */
function backfillSettlementStatuses(db: DatabaseSync): void {
  const rows = db.prepare('SELECT id, method, status, created_at FROM settlements ORDER BY rowid').all() as unknown as {
    id: string;
    method: string;
    status: string;
    created_at: string;
  }[];
  const insert = db.prepare('INSERT INTO settlement_statuses (settlement_id, status, at) VALUES (?, ?, ?)');
  for (const row of rows) {
    for (const status of statusesBeforeHistory(row)) insert.run(row.id, status, row.created_at);
  }
}

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
  // A membership written before balances passed on to the owner has no base: none had passed on yet.
  if (!membershipColumns.some(column => column.name === 'balance_base')) {
    db.exec('ALTER TABLE group_members ADD COLUMN balance_base INTEGER NOT NULL DEFAULT 0');
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
  // A notices table written before reminders lacks their kind, and requires an expense: its rows are kept.
  const noticesTable = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notices'`).get() as
    { sql: string } | undefined;
  if (noticesTable && !noticesTable.sql.includes(`'reminder'`)) {
    db.exec('ALTER TABLE notices RENAME TO notices_before_reminders');
    db.exec(NOTICES_TABLE);
    db.exec(
      `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
       SELECT id, recipient_id, kind, group_id, expense_id, amount, created_at FROM notices_before_reminders`,
    );
    db.exec('DROP TABLE notices_before_reminders');
  }
  // An expense written before expenses in another currency is in the group's currency: it has no original amount.
  if (!expenseColumns.some(column => column.name === 'rate')) {
    db.exec('ALTER TABLE expenses ADD COLUMN original_currency TEXT');
    db.exec('ALTER TABLE expenses ADD COLUMN original_amount INTEGER');
    db.exec('ALTER TABLE expenses ADD COLUMN rate TEXT');
  }
  // An expense written before recurring expenses was not recorded for one.
  if (!expenseColumns.some(column => column.name === 'recurring_id')) {
    db.exec('ALTER TABLE expenses ADD COLUMN recurring_id TEXT');
    db.exec('ALTER TABLE expenses ADD COLUMN recurring_day TEXT');
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
      // A file with no history of its settlements yet (one written before it was kept) has its settlements backfilled.
      const historyIsNew =
        db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settlement_statuses'`).get() ===
        undefined;
      db.exec(SCHEMA);
      db.exec(SETTLEMENTS_TABLE);
      db.exec(NOTICES_TABLE);
      addMissingColumns(db);
      // After the settlements' rebuilds: a table referencing `settlements` would follow a rename of it.
      db.exec(SETTLEMENT_STATUSES_TABLE);
      if (historyIsNew) backfillSettlementStatuses(db);
      // After the columns exist: an index on a column a file written before lacks would fail.
      db.exec('CREATE INDEX IF NOT EXISTS settlements_by_payment ON settlements (provider_payment_id)');
      // One expense per day of a recurring expense, whatever servers share the file.
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS expenses_by_recurring_day ON expenses (recurring_id, recurring_day) WHERE recurring_id IS NOT NULL',
      );
      db.exec('CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient_id, created_at)');
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
