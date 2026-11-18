import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CATEGORY_SQL_LIST } from './categories';

/**
 * The file Tally kept before the database was PostgreSQL: a SQLite file, written by this version's SQLite schema or an
 * earlier one. It is only read, once, to move its rows into the database (see `openDatabase`). Its schema is upgraded
 * on a copy of it, so the file itself is never written.
 */

/** The rows of one table of the file, in the order they were written. */
export interface LegacyTable {
  readonly name: string;
  readonly rows: Record<string, unknown>[];
}

/**
 * The schema of the file, created when missing. Every table is created with `IF NOT EXISTS`, so a file of any earlier
 * version gets the tables it lacks.
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
    created_at TEXT NOT NULL,
    archived_at TEXT
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
    category    TEXT NOT NULL DEFAULT 'other' CHECK (category IN (${CATEGORY_SQL_LIST})),
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id TEXT NOT NULL REFERENCES expenses (id),
    position   INTEGER NOT NULL,
    member_id  TEXT NOT NULL REFERENCES accounts (id),
    amount     INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  );
  CREATE TABLE IF NOT EXISTS recurring (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups (id),
    paid_by     TEXT NOT NULL REFERENCES accounts (id),
    description TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    starts_on   TEXT NOT NULL,
    next_on     TEXT NOT NULL,
    split_kind  TEXT NOT NULL CHECK (split_kind IN ('equal', 'exact', 'shares')),
    category    TEXT NOT NULL DEFAULT 'other' CHECK (category IN (${CATEGORY_SQL_LIST})),
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
  CREATE TABLE IF NOT EXISTS lasting_debts (
    group_id         TEXT NOT NULL REFERENCES groups (id),
    account_id       TEXT NOT NULL REFERENCES accounts (id),
    noted_at         TEXT NOT NULL,
    last_reminded_at TEXT,
    PRIMARY KEY (group_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS budgets (
    group_id TEXT NOT NULL REFERENCES groups (id),
    category TEXT NOT NULL CHECK (category IN (${CATEGORY_SQL_LIST})),
    amount   INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
    PRIMARY KEY (group_id, category)
  );
  CREATE TABLE IF NOT EXISTS budget_months_passed (
    group_id  TEXT NOT NULL REFERENCES groups (id),
    category  TEXT NOT NULL CHECK (category IN (${CATEGORY_SQL_LIST})),
    month     TEXT NOT NULL,
    passed_at TEXT NOT NULL,
    PRIMARY KEY (group_id, category, month)
  );
  CREATE TABLE IF NOT EXISTS templates (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups (id),
    saved_by    TEXT NOT NULL REFERENCES accounts (id),
    name        TEXT NOT NULL,
    name_key    TEXT NOT NULL,
    split_kind  TEXT NOT NULL CHECK (split_kind IN ('equal', 'shares')),
    created_at  TEXT NOT NULL,
    UNIQUE (group_id, name_key)
  );
  CREATE TABLE IF NOT EXISTS template_parts (
    template_id TEXT NOT NULL REFERENCES templates (id),
    position    INTEGER NOT NULL,
    member_id   TEXT NOT NULL REFERENCES accounts (id),
    shares      INTEGER CHECK (shares IS NULL OR shares >= 1),
    PRIMARY KEY (template_id, position)
  );
`;

const NOTICES_TABLE = `
  CREATE TABLE IF NOT EXISTS notices (
    id           TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL REFERENCES accounts (id),
    kind         TEXT NOT NULL CHECK (kind IN ('expense', 'reminder', 'budget')),
    group_id     TEXT NOT NULL REFERENCES groups (id),
    expense_id   TEXT,
    category     TEXT CHECK (category IN (${CATEGORY_SQL_LIST})),
    month        TEXT,
    budget       INTEGER,
    amount       INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    CHECK ((kind = 'expense') = (expense_id IS NOT NULL)),
    CHECK ((kind = 'budget') = (budget IS NOT NULL AND month IS NOT NULL AND category IS NOT NULL)),
    UNIQUE (kind, expense_id, recipient_id)
  );
`;

const AUDIT_TABLE = `
  CREATE TABLE IF NOT EXISTS audit_entries (
    id         TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL REFERENCES groups (id),
    at         TEXT NOT NULL,
    by_id      TEXT NOT NULL REFERENCES accounts (id),
    action     TEXT NOT NULL CHECK (action IN ('expense-recorded', 'expense-edited', 'expense-deleted',
                 'settlement-paid', 'settlement-refunded', 'balance-passed')),
    subject_id TEXT NOT NULL,
    amount     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_entries_by_group ON audit_entries (group_id, at);
`;

const RECEIPTS_TABLE = `
  CREATE TABLE IF NOT EXISTS receipts (
    expense_id  TEXT PRIMARY KEY REFERENCES expenses (id),
    store_id    TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png')),
    size        INTEGER NOT NULL CHECK (size BETWEEN 1 AND 2097152),
    url         TEXT NOT NULL,
    attached_at TEXT NOT NULL
  );
`;

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

const SETTLEMENT_STATUSES_TABLE = `
  CREATE TABLE IF NOT EXISTS settlement_statuses (
    settlement_id TEXT NOT NULL REFERENCES settlements (id),
    status        TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
    at            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS settlement_statuses_by_settlement ON settlement_statuses (settlement_id);
`;

/** The statuses a settlement of a file written before its history was kept had, in order (see `backfill`). */
function statusesBeforeHistory(row: { method: string; status: string }): string[] {
  if (row.method === 'cash') return [row.status];
  const statuses = ['pending'];
  if (row.status === 'refunding') statuses.push('paid');
  if (row.status !== 'pending') statuses.push(row.status);
  return statuses;
}

/**
 * Writes the history of the settlements a file written before it has, from what they are now: each status at the time
 * the settlement was recorded, as the file does not say when they changed.
 */
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
 * Adds the columns a file written before them lacks: `CREATE TABLE IF NOT EXISTS` never alters a table that exists.
 * Each rule keeps the rows of the file as they were, with the value a row written before the column had.
 */
function addMissingColumns(db: DatabaseSync): void {
  const expenseColumns = db.prepare('PRAGMA table_info(expenses)').all() as unknown as { name: string }[];
  const membershipColumns = db.prepare('PRAGMA table_info(group_members)').all() as unknown as { name: string }[];
  const settlementColumns = db.prepare('PRAGMA table_info(settlements)').all() as unknown as { name: string }[];
  const recurringColumns = db.prepare('PRAGMA table_info(recurring)').all() as unknown as { name: string }[];
  const groupColumns = db.prepare('PRAGMA table_info(groups)').all() as unknown as { name: string }[];
  // A group written before archiving has no `archived_at`: none of them is archived.
  if (!groupColumns.some(column => column.name === 'archived_at')) {
    db.exec('ALTER TABLE groups ADD COLUMN archived_at TEXT');
  }
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
  // A notices table written before reminders lacks their kind, and requires an expense; one written before budgets
  // lacks the budget kind and its columns. Either way its rows are kept, as they are.
  const noticesTable = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notices'`).get() as
    { sql: string } | undefined;
  if (noticesTable && !noticesTable.sql.includes(`'budget'`)) {
    db.exec('ALTER TABLE notices RENAME TO notices_before_budgets');
    db.exec(NOTICES_TABLE);
    db.exec(
      `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
       SELECT id, recipient_id, kind, group_id, expense_id, amount, created_at FROM notices_before_budgets`,
    );
    db.exec('DROP TABLE notices_before_budgets');
  }
  // An expense written before categories is in `other`; so is a recurring expense written before them.
  if (!expenseColumns.some(column => column.name === 'category')) {
    db.exec(
      `ALTER TABLE expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK (category IN (${CATEGORY_SQL_LIST}))`,
    );
  }
  if (!recurringColumns.some(column => column.name === 'category')) {
    db.exec(
      `ALTER TABLE recurring ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK (category IN (${CATEGORY_SQL_LIST}))`,
    );
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

/** Brings the schema of a copy of the file to this version's: every table, column and rule it lacks. */
function upgradeCopy(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    const historyIsNew =
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settlement_statuses'`).get() ===
      undefined;
    db.exec(SCHEMA);
    db.exec(SETTLEMENTS_TABLE);
    db.exec(NOTICES_TABLE);
    db.exec(RECEIPTS_TABLE);
    db.exec(AUDIT_TABLE);
    addMissingColumns(db);
    // After the settlements' rebuilds: a table referencing `settlements` would follow a rename of it.
    db.exec(SETTLEMENT_STATUSES_TABLE);
    if (historyIsNew) backfillSettlementStatuses(db);
    // After the columns exist: an index on a column a file written before lacks would fail.
    db.exec('CREATE INDEX IF NOT EXISTS settlements_by_payment ON settlements (provider_payment_id)');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS expenses_by_recurring_day ON expenses (recurring_id, recurring_day) WHERE recurring_id IS NOT NULL',
    );
    db.exec('CREATE INDEX IF NOT EXISTS notices_by_recipient ON notices (recipient_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS expenses_by_category ON expenses (group_id, category, spent_on)');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Creates the SQLite file at `path` with this version's schema and no rows, as an earlier version of Tally would have
 * left it: the file a test fills with rows before moving them to the database.
 */
export function createLegacyFile(path: string): void {
  const db = new DatabaseSync(path);
  try {
    upgradeCopy(db);
  } finally {
    db.close();
  }
}

/** The tables of the file, each with its rows in the order they were written (the order of their `rowid`). */
const TABLES = [
  'accounts',
  'sessions',
  'operations',
  'groups',
  'group_members',
  'invitations',
  'expenses',
  'expense_shares',
  'recurring',
  'recurring_parts',
  'payout_accounts',
  'lasting_debts',
  'budgets',
  'budget_months_passed',
  'templates',
  'template_parts',
  'notices',
  'audit_entries',
  'receipts',
  'settlements',
  'settlement_statuses',
];

/**
 * Reads every table of the SQLite file at `path`, as this version's schema has them, rows in the order written. The
 * file is copied first (`VACUUM INTO` a directory of its own), and the copy is upgraded and read; the file is not written.
 */
export function readLegacyFile(path: string): LegacyTable[] {
  const directory = mkdtempSync(join(tmpdir(), 'tally-legacy-'));
  const copyPath = join(directory, 'copy.db');
  try {
    const source = new DatabaseSync(path);
    try {
      source.exec(`VACUUM INTO '${copyPath.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    const copy = new DatabaseSync(copyPath);
    try {
      upgradeCopy(copy);
      return TABLES.map(name => ({
        name,
        rows: copy.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all() as Record<string, unknown>[],
      }));
    } finally {
      copy.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
