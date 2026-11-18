import { existsSync } from 'node:fs';
import pg from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { LEGACY_TABLES, openLegacyFile, readLegacyRows } from './legacy-sqlite';

/**
 * What the data layer runs its statements with. A statement takes `?` for each value, in order, as SQLite's did; the values
 * are passed in a list. A read changes nothing; a write is run in a transaction (see `Database.transaction`).
 */
export interface Queryable {
  /** The first row the statement gives, or `undefined` when it gives none. */
  get<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<Row | undefined>;
  /** Every row the statement gives, in the order it gives them. */
  all<Row = unknown>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs the statement; `changes` is the number of rows it wrote, changed or removed. */
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;
  /** Runs statements that take no values, several at once if need be. */
  exec(sql: string): Promise<void>;
}

/** The database of Tally: a pool of connections to its PostgreSQL database. */
export interface Database extends Queryable {
  /**
   * Runs `work` in a write transaction: its writes all land, or, when it throws, none does. The transaction waits for the
   * write lock before `work` starts, so the write transactions of every server on the database run one after the other, and
   * each sees what the ones before it wrote. `work` must use the `tx` it is given for everything, never the database itself:
   * the database would wait for the lock that the transaction holds.
   */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Closes the connections. */
  close(): Promise<void>;
}

/** The advisory lock every write transaction takes: the one lock a write transaction waits for, whichever server runs it. */
const WRITE_LOCK = 1952802420;

/** The version of the schema this server keeps. The schema is one version: a database holding another is not read. */
const SCHEMA_VERSION = 1;

/**
 * The schema of Tally in PostgreSQL. The tables, columns and constraints are those the SQLite file had at its last version, with
 * `seq` where the file's order of rows (its rowid) mattered: the order of creation, which lists read. Integers are 8 bytes, as
 * SQLite's are, so that no value the file holds is out of range.
 */
const SCHEMA = `
CREATE TABLE schema_version (version BIGINT NOT NULL);

-- A deleted account keeps its id, and no more of the person: its name is erased, and its email and password hash are null, so
-- its email may be used by another account (a unique index allows many nulls). It is deleted when deleted_at is set.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT NOT NULL,
  password_hash TEXT,
  deleted_at TEXT,
  CHECK ((deleted_at IS NULL) = (email IS NOT NULL) AND (deleted_at IS NULL) = (password_hash IS NOT NULL))
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

CREATE TABLE groups (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL,
  archived_at TEXT,
  -- The group this one was merged into, once it was: a merged group no longer exists, its row is kept for the notices that name it.
  merged_into TEXT REFERENCES groups (id)
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  joined_at TEXT,
  joined_order BIGINT,
  left_at TEXT,
  balance_offset BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, account_id)
);
CREATE INDEX group_members_account ON group_members (account_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  created_by TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL
);

CREATE TABLE expenses (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  description TEXT NOT NULL,
  amount BIGINT NOT NULL,
  date TEXT NOT NULL,
  paid_by TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  split_kind TEXT NOT NULL DEFAULT 'equal' CHECK (split_kind IN ('equal', 'exact', 'shares')),
  original_currency TEXT,
  original_amount BIGINT,
  original_rate TEXT,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'))
);
CREATE INDEX expenses_group ON expenses (group_id);

CREATE TABLE expense_shares (
  expense_id TEXT NOT NULL REFERENCES expenses (id),
  position BIGINT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  amount BIGINT NOT NULL,
  PRIMARY KEY (expense_id, position)
);

-- What two people netted across their groups: the settlements of a netting are the ones whose netting_id is its id.
CREATE TABLE nettings (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  by_id TEXT NOT NULL REFERENCES accounts (id),
  with_id TEXT NOT NULL REFERENCES accounts (id),
  currency TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount >= 1),
  created_at TEXT NOT NULL
);

CREATE TABLE settlements (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  payer_id TEXT NOT NULL REFERENCES accounts (id),
  payee_id TEXT NOT NULL REFERENCES accounts (id),
  amount BIGINT NOT NULL CHECK (amount >= 1),
  method TEXT NOT NULL CHECK (method IN ('cash', 'provider', 'net')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled')),
  provider_id TEXT,
  pay_url TEXT,
  created_at TEXT NOT NULL,
  -- The netting this settlement is one of: exactly the settlements netted are one.
  netting_id TEXT REFERENCES nettings (id),
  CHECK ((method = 'net') = (netting_id IS NOT NULL))
);
CREATE INDEX settlements_group ON settlements (group_id);
CREATE UNIQUE INDEX settlements_provider ON settlements (provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE payment_decisions (
  payment_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('paid', 'failed', 'refunded')),
  decided_at TEXT
);

CREATE TABLE payout_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id),
  provider_account_id TEXT NOT NULL,
  set_at TEXT NOT NULL
);

CREATE TABLE notices (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'reminder', 'budget')),
  group_id TEXT NOT NULL REFERENCES groups (id),
  expense_id TEXT,
  category TEXT,
  month TEXT,
  budget BIGINT,
  amount BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (kind <> 'budget' OR (category IS NOT NULL AND month IS NOT NULL AND budget IS NOT NULL))
);
CREATE UNIQUE INDEX notices_expense_account ON notices (expense_id, account_id);
CREATE INDEX notices_account ON notices (account_id, created_at);

CREATE TABLE debt_notes (
  group_id TEXT NOT NULL REFERENCES groups (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  noted_at TEXT NOT NULL,
  reminded_at TEXT,
  PRIMARY KEY (group_id, account_id)
);

CREATE TABLE settlement_history (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES settlements (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled')),
  at TEXT NOT NULL
);
CREATE INDEX settlement_history_settlement ON settlement_history (settlement_id, seq);

CREATE TABLE recurring (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  paid_by TEXT NOT NULL REFERENCES accounts (id),
  description TEXT NOT NULL,
  amount BIGINT NOT NULL,
  starts_on TEXT NOT NULL,
  next_on TEXT NOT NULL,
  split_kind TEXT NOT NULL CHECK (split_kind IN ('equal', 'exact', 'shares')),
  created_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'))
);
CREATE INDEX recurring_group ON recurring (group_id, seq);

CREATE TABLE recurring_shares (
  recurring_id TEXT NOT NULL REFERENCES recurring (id),
  position BIGINT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  value BIGINT,
  PRIMARY KEY (recurring_id, position)
);

CREATE TABLE budgets (
  group_id TEXT NOT NULL REFERENCES groups (id),
  category TEXT NOT NULL CHECK (category IN ('groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other')),
  amount BIGINT NOT NULL CHECK (amount >= 1),
  PRIMARY KEY (group_id, category)
);

CREATE TABLE budget_passings (
  group_id TEXT NOT NULL REFERENCES groups (id),
  category TEXT NOT NULL,
  month TEXT NOT NULL,
  PRIMARY KEY (group_id, category, month)
);

CREATE TABLE templates (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  split_kind TEXT NOT NULL CHECK (split_kind IN ('equal', 'shares')),
  created_by TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL,
  UNIQUE (group_id, name_key)
);

CREATE TABLE template_shares (
  template_id TEXT NOT NULL REFERENCES templates (id),
  position BIGINT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  value BIGINT,
  PRIMARY KEY (template_id, position)
);

CREATE TABLE receipts (
  expense_id TEXT PRIMARY KEY REFERENCES expenses (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png')),
  size BIGINT NOT NULL CHECK (size BETWEEN 1 AND 2097152),
  store_id TEXT NOT NULL,
  url TEXT NOT NULL,
  attached_at TEXT NOT NULL
);

CREATE TABLE audit_entries (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  at TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  action TEXT NOT NULL CHECK (action IN (
    'expense-recorded', 'expense-edited', 'expense-deleted', 'settlement-paid', 'settlement-refunded', 'balance-passed',
    'settlement-contested'
  )),
  subject_id TEXT NOT NULL,
  amount BIGINT NOT NULL
);
CREATE INDEX audit_entries_group ON audit_entries (group_id, seq);

-- What the administrators decided on the settlements contested: the administrators' log, which nothing changes or removes.
-- The administrators' log. Its subject is a settlement when an administrator decides it, and an account when one suspends or
-- reinstates it, so the subject is not a reference to one table.
CREATE TABLE admin_log (
  seq BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  action TEXT NOT NULL CHECK (action IN ('decided-paid', 'decided-annulled', 'suspended', 'reinstated')),
  subject_id TEXT NOT NULL
);

-- The accounts an administrator has suspended and not yet reinstated: a suspended account cannot record money, in any group.
CREATE TABLE suspensions (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id),
  suspended_at TEXT NOT NULL
);
`;

/**
 * Turns the `?` of a statement into PostgreSQL's `$1`, `$2`, ... in order, leaving the `?` inside a quoted text alone.
 */
function numbered(sql: string): string {
  let count = 0;
  let quoted = false;
  let text = '';
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    if (char === '?' && !quoted) {
      count += 1;
      text += `$${count}`;
    } else {
      text += char;
    }
  }
  return text;
}

/** Runs statements on a pool or on one of its clients: the same for both. */
interface Runner {
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}

function queryableOf(runner: Runner): Queryable {
  return {
    async get<Row>(sql: string, params: readonly unknown[] = []) {
      const result = await runner.query(numbered(sql), [...params]);
      return result.rows[0] as Row | undefined;
    },
    async all<Row>(sql: string, params: readonly unknown[] = []) {
      const result = await runner.query(numbered(sql), [...params]);
      return result.rows as Row[];
    },
    async run(sql: string, params: readonly unknown[] = []) {
      const result = await runner.query(numbered(sql), [...params]);
      return { changes: result.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await runner.query(sql);
    },
  };
}

/**
 * Opens the PostgreSQL database at `url`, and brings it up to date: a database that holds nothing of Tally's yet gets the schema,
 * and, when `legacyPath` names a SQLite file Tally kept, everything that file holds, in the same transaction, so that it is all
 * there or none of it is. A database that already holds Tally's state is served as it is: the file is not read again.
 * Servers starting at once on one database take the write lock in turn, so only one of them prepares it.
 */
export async function openDatabase(url: string, legacyPath?: string): Promise<Database> {
  const pool = new pg.Pool({
    connectionString: url,
    max: 8,
    types: {
      // Integers are numbers here, as they are of SQLite: 8-byte integers (oid 20), and the sums of integers, which PostgreSQL
      // gives as numerics (oid 1700). Every amount is far below the largest safe integer, so no value is rounded.
      getTypeParser: (oid: number, format?: 'text' | 'binary') =>
        oid === 20 || oid === 1700 ? (value: string) => Number(value) : pg.types.getTypeParser(oid, format),
    },
  });
  // A connection the pool holds that fails is dropped by the pool; the next statement takes another one.
  pool.on('error', () => undefined);
  const database: Database = {
    ...queryableOf(pool),
    async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);
        const result = await work(queryableOf(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    close: () => pool.end(),
  };
  try {
    await prepare(database, legacyPath);
    return database;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

/** Creates the schema, and moves the legacy file into it, when the database holds nothing of Tally's yet. */
async function prepare(database: Database, legacyPath: string | undefined): Promise<void> {
  await database.transaction(async tx => {
    // The table of the schema's version is there once the schema is: a database holding it holds Tally's state.
    const existing = await tx.get<{ present: string | null }>("SELECT to_regclass('schema_version')::text AS present");
    if (existing?.present) return;
    await tx.exec(SCHEMA);
    if (legacyPath !== undefined && existsSync(legacyPath)) await moveLegacyFile(tx, legacyPath);
    await tx.run('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION]);
  });
}

/** Writes every row of the SQLite file into the tables of the schema, in the order of `LEGACY_TABLES`. */
async function moveLegacyFile(tx: Queryable, legacyPath: string): Promise<void> {
  const legacy = openLegacyFile(legacyPath);
  try {
    for (const { table, columns } of LEGACY_TABLES) {
      const placeholders = columns.map(() => '?').join(', ');
      for (const row of readLegacyRows(legacy, table, columns)) {
        await tx.run(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
          columns.map(column => row[column] ?? null),
        );
      }
    }
  } finally {
    legacy.close();
  }
}
