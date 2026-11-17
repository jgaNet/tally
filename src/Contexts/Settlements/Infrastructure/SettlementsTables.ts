import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The settlements' books and settlements, in the application's file, made by whoever opens it first. A group's book has one
 * row, at its version (CONC-OPTIMISTIC): 1 once its first settlement is stored, one more at each change after it. A settlement
 * is kept once it is recorded; its status changes only when the provider says how its payment ended (pending, then paid or
 * failed). A payment through the provider keeps the provider's id for it (unique, the webhook finds the settlement by it) and
 * the link the payer pays at.
 */
export function createSettlementsTables(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS settlement_books (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS settlements (
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
  database.exec('CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id)');
  database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id)',
  );
  // A person's payout account at the provider (request 16): one row per person, unique by owner, at its version.
  database.exec(`CREATE TABLE IF NOT EXISTS payout_accounts (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    version INTEGER NOT NULL
  )`);
}
