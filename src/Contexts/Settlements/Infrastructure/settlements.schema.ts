/**
 * Settlements' tables in the SQLite file (ADR 2, ADR 7, ADR 8). `settlement_books` holds each group's book at its version,
 * which the optimistic check reads; `settlements` holds each settlement, with its payer, payee, amount, method, status and
 * when it was recorded, and for a payment through the provider its id at the provider and its link. A settlement's status
 * changes from pending to paid or failed, when the provider says so; from paid to refunding when its payee asks for a refund,
 * and to refunded when the provider says so (ADR 9). A table an earlier version made keeps its CHECK: it is created again.
 */
export const SETTLEMENT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS settlement_books (
     group_id TEXT PRIMARY KEY,
     version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS settlements (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     payer_id TEXT NOT NULL,
     payee_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     method TEXT NOT NULL CHECK (method IN ('cash', 'provider')),
     status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'refunding', 'refunded')),
     recorded_at TEXT NOT NULL,
     provider_payment_id TEXT,
     pay_url TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id)`,
  `CREATE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id)`,
  // A person's payout account at the provider (request 16, ADR 10): one row per person, replaced when they set another.
  `CREATE TABLE IF NOT EXISTS payout_accounts (
     id TEXT PRIMARY KEY,
     owner_id TEXT NOT NULL UNIQUE,
     account_id TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
];
