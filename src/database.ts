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
  `
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups (id),
    account_id TEXT NOT NULL REFERENCES accounts (id),
    PRIMARY KEY (group_id, account_id)
  );
  CREATE INDEX group_members_account ON group_members (account_id);
  `,
  `
  ALTER TABLE group_members ADD COLUMN joined_at TEXT;
  UPDATE group_members SET joined_at = (SELECT g.created_at FROM groups g WHERE g.id = group_members.group_id);

  CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups (id),
    created_by TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups (id),
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    date TEXT NOT NULL,
    paid_by TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );

  -- The shares of an expense, in the order its split was given: position is that order.
  CREATE TABLE expense_shares (
    expense_id TEXT NOT NULL REFERENCES expenses (id),
    position INTEGER NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    amount INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  );
  `,
  `
  -- The version of an expense: 1 when it is recorded, one more at each edit. Expenses recorded before
  -- versions existed were never edited, so they are at version 1.
  ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
  `,
  `
  -- How an expense was split: 'equal' between its members, 'exact' by amounts, or 'shares' by a number of
  -- shares each. Expenses recorded before splits could be unequal were all split equally.
  ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'
    CHECK (split_kind IN ('equal', 'exact', 'shares'));
  `,
  `
  -- A membership is a row of group_members, from the moment its member joins. When the member leaves, the
  -- row stays, with the moment it ended in left_at: it is current while left_at is null. A member who
  -- joins again has their row renewed, and so is last in the group's order of members: joined_order is
  -- that order, one more than the last one given at each join.
  ALTER TABLE group_members ADD COLUMN left_at TEXT;
  ALTER TABLE group_members ADD COLUMN joined_order INTEGER;
  UPDATE group_members SET joined_order = (
    SELECT COUNT(*) FROM group_members o
    WHERE o.group_id = group_members.group_id
      AND (o.joined_at < group_members.joined_at
           OR (o.joined_at = group_members.joined_at AND o.rowid <= group_members.rowid)));
  `,
  `
  -- A settlement: the payee, who records it, was paid the amount in cash by the payer, in hundredths of the
  -- group's currency. It is never recorded as anything but cash, and it is paid from the moment it is recorded.
  CREATE TABLE settlements (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups (id),
    payer_id TEXT NOT NULL REFERENCES accounts (id),
    payee_id TEXT NOT NULL REFERENCES accounts (id),
    amount INTEGER NOT NULL CHECK (amount >= 1),
    method TEXT NOT NULL CHECK (method IN ('cash')),
    status TEXT NOT NULL CHECK (status IN ('paid')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX settlements_group ON settlements (group_id);
  `,
  `
  -- A settlement may also be paid through the payment provider: method 'provider'. It is 'pending' while the
  -- provider has not decided it, then 'paid' or 'failed'. A settlement through the provider has the provider's
  -- id of its payment, and the link where the payer pays it; both are null until the provider has answered.
  -- SQLite cannot change a CHECK constraint, so the table is rebuilt, its rows copied as they are.
  CREATE TABLE settlements_next (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups (id),
    payer_id TEXT NOT NULL REFERENCES accounts (id),
    payee_id TEXT NOT NULL REFERENCES accounts (id),
    amount INTEGER NOT NULL CHECK (amount >= 1),
    method TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
    provider_id TEXT,
    pay_url TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO settlements_next (id, group_id, payer_id, payee_id, amount, method, status, created_at)
    SELECT id, group_id, payer_id, payee_id, amount, method, status, created_at FROM settlements;
  DROP TABLE settlements;
  ALTER TABLE settlements_next RENAME TO settlements;
  CREATE INDEX settlements_group ON settlements (group_id);
  CREATE UNIQUE INDEX settlements_provider ON settlements (provider_id) WHERE provider_id IS NOT NULL;
  `,
  `
  -- The decision the provider made on a payment, 'paid' or 'failed', as the first webhook that decided it carried
  -- it. A webhook may overtake the provider's answer to the request for its payment: until that answer is kept on
  -- the settlement, the settlement has no payment id, so the decision waits here and is applied when it is kept.
  -- A payment ends once, so the first decision is the one kept.
  CREATE TABLE payment_decisions (
    payment_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('paid', 'failed'))
  );
  `,
  `
  -- A settlement through the provider may be refunded: 'refunding' while the provider is asked for the refund,
  -- then 'refunded' once it says the payment is refunded. A payment's decision may be 'refunded' too: a payment
  -- that succeeded is refunded later. Both CHECK constraints are rebuilt, their rows copied as they are.
  CREATE TABLE settlements_next (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups (id),
    payer_id TEXT NOT NULL REFERENCES accounts (id),
    payee_id TEXT NOT NULL REFERENCES accounts (id),
    amount INTEGER NOT NULL CHECK (amount >= 1),
    method TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
    provider_id TEXT,
    pay_url TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO settlements_next (id, group_id, payer_id, payee_id, amount, method, status, provider_id, pay_url, created_at)
    SELECT id, group_id, payer_id, payee_id, amount, method, status, provider_id, pay_url, created_at FROM settlements;
  DROP TABLE settlements;
  ALTER TABLE settlements_next RENAME TO settlements;
  CREATE INDEX settlements_group ON settlements (group_id);
  CREATE UNIQUE INDEX settlements_provider ON settlements (provider_id) WHERE provider_id IS NOT NULL;

  CREATE TABLE payment_decisions_next (
    payment_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('paid', 'failed', 'refunded'))
  );
  INSERT INTO payment_decisions_next (payment_id, status) SELECT payment_id, status FROM payment_decisions;
  DROP TABLE payment_decisions;
  ALTER TABLE payment_decisions_next RENAME TO payment_decisions;
  `,
  `
  -- A member's payout account: the provider's id of the account the provider pays the member on. Setting another
  -- replaces this one, so a member has at most one. A member without one is not paid through the provider.
  CREATE TABLE payout_accounts (
    account_id TEXT PRIMARY KEY REFERENCES accounts (id),
    provider_account_id TEXT NOT NULL,
    set_at TEXT NOT NULL
  );
  `,
  `
  -- A notice tells a member of an expense's split, other than its payer, their share of it. It is written in the
  -- same transaction that records the expense, so it exists exactly when the expense does, and once per member:
  -- the unique index refuses a second one. It belongs to its account for good: it is not removed when the member
  -- leaves the group, nor when the expense is deleted, so expense_id is not a foreign key.
  CREATE TABLE notices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    kind TEXT NOT NULL CHECK (kind IN ('expense')),
    group_id TEXT NOT NULL REFERENCES groups (id),
    expense_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX notices_expense_account ON notices (expense_id, account_id);
  CREATE INDEX notices_account ON notices (account_id, created_at);
  `,
  `
  -- A reminder is a notice of its own kind, with no expense: the table is rebuilt so expense_id may be null and
  -- kind may be 'reminder', its rows copied in the order they were written. debt_notes keeps, for each member
  -- of a group the background job sees owing more than 2000, the run it noted that from, and when it last
  -- reminded them; a member it no longer sees owing that has no row.
  CREATE TABLE notices_next (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'reminder')),
    group_id TEXT NOT NULL REFERENCES groups (id),
    expense_id TEXT,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO notices_next (id, account_id, kind, group_id, expense_id, amount, created_at)
    SELECT id, account_id, kind, group_id, expense_id, amount, created_at FROM notices ORDER BY rowid;
  DROP TABLE notices;
  ALTER TABLE notices_next RENAME TO notices;
  CREATE UNIQUE INDEX notices_expense_account ON notices (expense_id, account_id);
  CREATE INDEX notices_account ON notices (account_id, created_at);

  CREATE TABLE debt_notes (
    group_id TEXT NOT NULL REFERENCES groups (id),
    account_id TEXT NOT NULL REFERENCES accounts (id),
    noted_at TEXT NOT NULL,
    reminded_at TEXT,
    PRIMARY KEY (group_id, account_id)
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

/**
 * Runs `work` in a write transaction that waits for the write lock: its writes all land, or, when it
 * throws, none does.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
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

function migrate(db: DatabaseSync): void {
  inTransaction(db, () => {
    const current = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let version = current; version < MIGRATIONS.length; version++) {
      db.exec(MIGRATIONS[version]);
    }
    if (current < MIGRATIONS.length) db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
  });
}
