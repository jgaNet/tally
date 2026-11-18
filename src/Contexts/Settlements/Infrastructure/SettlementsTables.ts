import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * The settlements' books and settlements, in the application's database, made by whoever prepares it first. A group's book has one
 * row, at its version (CONC-OPTIMISTIC): 1 once its first settlement is stored, one more at each change after it. A settlement
 * is kept once it is recorded; its status changes only when the provider says how its payment ended (pending, then paid or
 * failed). A payment through the provider keeps the provider's id for it (unique, the webhook finds the settlement by it) and
 * the link the payer pays at.
 */
export function createSettlementsTables(database: PostgresDatabase): void {
  database.declare(`CREATE TABLE IF NOT EXISTS settlement_books (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL
  )`);
  database.declare(`CREATE TABLE IF NOT EXISTS settlements (
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    payer TEXT NOT NULL,
    payee TEXT NOT NULL,
    amount INTEGER NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    provider_payment_id TEXT,
    pay_url TEXT
  )`);
  database.declare('CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id)');
  database.declare(
    'CREATE UNIQUE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id)',
  );
  // Every status a settlement has had, the earliest first (request 19): one line per status Tally learned, written in the
  // transaction of the change it records, and never changed. `position` counts from 1 within its settlement.
  database.declare(`CREATE TABLE IF NOT EXISTS settlement_history (
    settlement_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL,
    learned_at TEXT NOT NULL,
    PRIMARY KEY (settlement_id, position)
  )`);
  // The audit of the money the settlements move (request 28): an entry per change that starts or stops a settlement counting, written
  // in the transaction of that change. Its id names the change, and a settlement moves money once each way, so an id is written once.
  database.declare(`CREATE TABLE IF NOT EXISTS settlement_audit_entries (
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    at TEXT NOT NULL,
    by_account TEXT NOT NULL,
    action TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    amount INTEGER NOT NULL
  )`);
  database.declare('CREATE INDEX IF NOT EXISTS settlement_audit_by_group ON settlement_audit_entries (group_id)');
  // The administrators' log (request 33): one row per decision an administrator made about a contested settlement, written in the
  // decision's transaction and never changed. `seq` keeps the order they were made in.
  database.declare(`CREATE TABLE IF NOT EXISTS settlement_administrator_decisions (
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    by_account TEXT NOT NULL,
    action TEXT NOT NULL,
    subject_id TEXT NOT NULL
  )`);
  // What two people netted across their groups (request 32): one row per netting, written once, and its settlements in the order they
  // were made (`position` counts from 1). A netting's settlements are the settlements of its groups' books, stored in the same transaction.
  database.declare(`CREATE TABLE IF NOT EXISTS nettings (
    id TEXT PRIMARY KEY,
    by_account TEXT NOT NULL,
    with_account TEXT NOT NULL,
    currency TEXT NOT NULL,
    amount INTEGER NOT NULL
  )`);
  database.declare(`CREATE TABLE IF NOT EXISTS netting_settlements (
    netting_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    settlement_id TEXT NOT NULL,
    PRIMARY KEY (netting_id, position)
  )`);
  // A person's payout account at the provider (request 16): one row per person, unique by owner, at its version.
  database.declare(`CREATE TABLE IF NOT EXISTS payout_accounts (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    version INTEGER NOT NULL
  )`);
  // Who bears the provider's fee of a group's payments, as its owner said (request 38): a book's column, the payee until it is said. A
  // payment through the provider keeps the fee it was asked with, and what it settles (`settled_amount`, its amount less the payer's part);
  // a settlement with no fee keeps neither, and settles its amount.
  database.declare("ALTER TABLE settlement_books ADD COLUMN IF NOT EXISTS fee_policy TEXT NOT NULL DEFAULT 'payee'");
  database.declare('ALTER TABLE settlements ADD COLUMN IF NOT EXISTS settled_amount INTEGER');
  database.declare('ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_amount INTEGER');
  database.declare('ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_borne_by TEXT');
}
