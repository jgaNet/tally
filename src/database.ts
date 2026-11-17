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
  `
  -- The invitation's id is the secret a link carries, so only its hash is kept, as a session's is.
  CREATE TABLE invitations (
    id_hash    TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL REFERENCES groups (id),
    invited_by TEXT NOT NULL REFERENCES accounts (id),
    created_at TEXT NOT NULL
  );
  `,
  `
  -- The amount is in hundredths of the group's currency. A share's position is its place in the split.
  CREATE TABLE expenses (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups (id),
    description TEXT NOT NULL,
    amount      INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 100000000),
    date        TEXT NOT NULL,
    paid_by     TEXT NOT NULL REFERENCES accounts (id),
    created_at  TEXT NOT NULL
  );
  CREATE INDEX expenses_by_group ON expenses (group_id);
  CREATE TABLE expense_shares (
    expense_id TEXT NOT NULL REFERENCES expenses (id),
    position   INTEGER NOT NULL,
    member_id  TEXT NOT NULL REFERENCES accounts (id),
    amount     INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  );
  `,
  `
  -- An expense is version 1 when recorded, and one more at each edit. An edit names the version it was
  -- made from; an expense recorded before this step is version 1.
  ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
  `,
  `
  -- How an expense is split. An expense recorded before this step was split equally.
  ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'
    CHECK (split_kind IN ('equal', 'exact', 'shares'));
  `,
  `
  -- A member who leaves loses their membership row. Their leaving is kept, so the group's members can
  -- still read their statement. A later join makes a new membership row, which is last in the order.
  CREATE TABLE former_members (
    group_id   TEXT NOT NULL REFERENCES groups (id),
    account_id TEXT NOT NULL REFERENCES accounts (id),
    left_at    TEXT NOT NULL,
    PRIMARY KEY (group_id, account_id)
  );
  `,
  `
  -- A settlement moves money between two members of a group, and is never edited. The amount is in
  -- hundredths of the group's currency. Only cash is kept so far, and a settlement is paid when recorded.
  CREATE TABLE settlements (
    id         TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL REFERENCES groups (id),
    payer_id   TEXT NOT NULL REFERENCES accounts (id),
    payee_id   TEXT NOT NULL REFERENCES accounts (id),
    amount     INTEGER NOT NULL CHECK (amount >= 1),
    method     TEXT NOT NULL CHECK (method IN ('cash')),
    status     TEXT NOT NULL CHECK (status IN ('paid')),
    created_at TEXT NOT NULL,
    CHECK (payer_id <> payee_id)
  );
  CREATE INDEX settlements_by_group ON settlements (group_id);
  `,
  `
  -- A settlement through the payment provider is pending until the provider says it ended: succeeded
  -- (paid) or failed. Its payUrl and the provider's payment id are kept with it. SQLite cannot widen a
  -- CHECK, so the table is rebuilt and every row copied; the rows before this step are cash, paid.
  CREATE TABLE settlements_next (
    id                  TEXT PRIMARY KEY,
    group_id            TEXT NOT NULL REFERENCES groups (id),
    payer_id            TEXT NOT NULL REFERENCES accounts (id),
    payee_id            TEXT NOT NULL REFERENCES accounts (id),
    amount              INTEGER NOT NULL CHECK (amount >= 1),
    method              TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
    status              TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
    pay_url             TEXT,
    provider_payment_id TEXT,
    created_at          TEXT NOT NULL,
    CHECK (payer_id <> payee_id),
    CHECK (method = 'provider' OR status = 'paid'),
    CHECK (status <> 'pending' OR method = 'provider'),
    CHECK (method = 'provider' OR pay_url IS NULL)
  );
  INSERT INTO settlements_next
    (id, group_id, payer_id, payee_id, amount, method, status, pay_url, provider_payment_id, created_at)
    SELECT id, group_id, payer_id, payee_id, amount, method, status, NULL, NULL, created_at FROM settlements;
  DROP TABLE settlements;
  ALTER TABLE settlements_next RENAME TO settlements;
  CREATE INDEX settlements_by_group ON settlements (group_id);
  CREATE INDEX settlements_by_provider_payment ON settlements (provider_payment_id);
  `,
  `
  -- A payment through the provider is refunded in two steps: refunding while the provider has the refund
  -- in hand, then refunded once it says so. A refunded payment is counted by no balance. Cash is never
  -- refunded, so only a provider payment can carry these statuses. SQLite cannot widen a CHECK, so the
  -- table is rebuilt and every row copied, as before.
  CREATE TABLE settlements_next (
    id                  TEXT PRIMARY KEY,
    group_id            TEXT NOT NULL REFERENCES groups (id),
    payer_id            TEXT NOT NULL REFERENCES accounts (id),
    payee_id            TEXT NOT NULL REFERENCES accounts (id),
    amount              INTEGER NOT NULL CHECK (amount >= 1),
    method              TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
    status              TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
    pay_url             TEXT,
    provider_payment_id TEXT,
    created_at          TEXT NOT NULL,
    CHECK (payer_id <> payee_id),
    CHECK (method = 'provider' OR status = 'paid'),
    CHECK (status <> 'pending' OR method = 'provider'),
    CHECK (method = 'provider' OR pay_url IS NULL)
  );
  INSERT INTO settlements_next
    (id, group_id, payer_id, payee_id, amount, method, status, pay_url, provider_payment_id, created_at)
    SELECT id, group_id, payer_id, payee_id, amount, method, status, pay_url, provider_payment_id, created_at
      FROM settlements;
  DROP TABLE settlements;
  ALTER TABLE settlements_next RENAME TO settlements;
  CREATE INDEX settlements_by_group ON settlements (group_id);
  CREATE INDEX settlements_by_provider_payment ON settlements (provider_payment_id);
  `,
  `
  -- A member's payout account: the provider's id of the account it pays them on. Setting another replaces
  -- it. A member has at most one, so the account is the key.
  CREATE TABLE payout_accounts (
    account_id          TEXT PRIMARY KEY REFERENCES accounts (id),
    provider_account_id TEXT NOT NULL CHECK (provider_account_id <> ''),
    set_at              TEXT NOT NULL
  );
  `,
  `
  -- A notice tells a member of an expense's split, other than its payer, their share of it. It is written in
  -- the same transaction as the expense, so each member gets one exactly, and it is kept with its member
  -- even after they leave the group. The expense may be deleted later: the notice is still kept.
  CREATE TABLE notices (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    kind       TEXT NOT NULL CHECK (kind IN ('expense')),
    group_id   TEXT NOT NULL REFERENCES groups (id),
    expense_id TEXT NOT NULL,
    amount     INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (expense_id, account_id)
  );
  CREATE INDEX notices_by_account ON notices (account_id, created_at);
  `,
  `
  -- A member who owes more than 2000 in a group is noted from the background job's run that first sees it,
  -- and is no longer noted at a run that sees them owe 2000 or less. Only the members of the group are kept.
  CREATE TABLE noted_debts (
    group_id   TEXT NOT NULL REFERENCES groups (id),
    account_id TEXT NOT NULL REFERENCES accounts (id),
    noted_at   TEXT NOT NULL,
    PRIMARY KEY (group_id, account_id)
  );
  `,
  `
  -- A reminder is a notice of its own kind: it names no expense, and its amount is what the member still
  -- owes, more than 2000. SQLite cannot widen a CHECK or drop a NOT NULL, so the table is rebuilt and every
  -- row copied; the rows before this step are expense notices, which name their expense.
  CREATE TABLE notices_next (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts (id),
    kind       TEXT NOT NULL CHECK (kind IN ('expense', 'reminder')),
    group_id   TEXT NOT NULL REFERENCES groups (id),
    expense_id TEXT,
    amount     INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (expense_id, account_id),
    CHECK ((kind = 'expense' AND expense_id IS NOT NULL) OR (kind = 'reminder' AND expense_id IS NULL)),
    CHECK (kind <> 'reminder' OR amount > 2000)
  );
  INSERT INTO notices_next (id, account_id, kind, group_id, expense_id, amount, created_at)
    SELECT id, account_id, kind, group_id, expense_id, amount, created_at FROM notices;
  DROP TABLE notices;
  ALTER TABLE notices_next RENAME TO notices;
  CREATE INDEX notices_by_account ON notices (account_id, created_at);
  `,
  `
  -- Every status a settlement has had, in the order Tally learned of them: one row per change, never
  -- edited. \`id\` is an autoincrement so that rows written in the same millisecond keep their order. The
  -- rows before this step are reconstructed from the settlement: a cash one was paid when recorded; a
  -- provider one was pending when recorded and then went on to the status it has, through paid when that
  -- status is refunding or refunded. Their times are not known, so each is the settlement's own time.
  CREATE TABLE settlement_statuses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id TEXT NOT NULL REFERENCES settlements (id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
    at            TEXT NOT NULL
  );
  CREATE INDEX settlement_statuses_by_settlement ON settlement_statuses (settlement_id, id);
  INSERT INTO settlement_statuses (settlement_id, status, at)
    SELECT id, CASE WHEN method = 'cash' THEN 'paid' ELSE 'pending' END, created_at FROM settlements;
  INSERT INTO settlement_statuses (settlement_id, status, at)
    SELECT id, 'paid', created_at FROM settlements
     WHERE method = 'provider' AND status IN ('paid', 'refunding', 'refunded');
  INSERT INTO settlement_statuses (settlement_id, status, at)
    SELECT id, status, created_at FROM settlements
     WHERE method = 'provider' AND status IN ('failed', 'refunding', 'refunded');
  `,
  `
  -- The balance a member had when they left, passed on to the owner of the group: one row per leaving, never
  -- edited. The amount is in hundredths of the group's currency, positive when the group owed the member. A
  -- member's balance counts what came to them and not what went from them, so one who leaves at a balance
  -- of B is at 0 from then on, even if they join again.
  CREATE TABLE balance_transfers (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL REFERENCES groups (id),
    from_id  TEXT NOT NULL REFERENCES accounts (id),
    to_id    TEXT NOT NULL REFERENCES accounts (id),
    amount   INTEGER NOT NULL,
    at       TEXT NOT NULL
  );
  CREATE INDEX balance_transfers_by_group ON balance_transfers (group_id);
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
