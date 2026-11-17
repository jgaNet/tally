/**
 * Settlements' tables in the SQLite file (ADR 2, ADR 7). `settlement_books` holds each group's book at its version, which
 * the optimistic check reads; `settlements` holds each settlement recorded, with its payer, payee, amount, method, status
 * and when it was recorded. A settlement is never changed once recorded.
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
     method TEXT NOT NULL CHECK (method IN ('cash')),
     status TEXT NOT NULL CHECK (status IN ('paid')),
     recorded_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id)`,
];
