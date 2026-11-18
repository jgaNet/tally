/**
 * The receipts in the PostgreSQL database (request 26, ADR 19, ADR 22). A receipt is one row of `ledger_receipts`, at its version: one per
 * expense (`expense_id` is unique), so two attaches that race cannot both be stored. `stored_id` and `url` are what the
 * receipts store answered when it kept the file. The file itself is not here.
 */
export const RECEIPT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ledger_receipts (
     id TEXT PRIMARY KEY,
     expense_id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png')),
     size BIGINT NOT NULL,
     stored_id TEXT NOT NULL,
     url TEXT NOT NULL,
     attached_at TEXT NOT NULL,
     version BIGINT NOT NULL
   )`,
];
