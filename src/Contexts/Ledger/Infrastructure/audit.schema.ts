/**
 * The audit of the expenses' changes (request 28), in the application's PostgreSQL database (ADR 22). One row per change, written in the
 * transaction of the change and never changed: an expense's row stays when the expense is deleted. The other changes of money
 * (the settlements, the balances that passed) are kept by their own contexts and read through their ports. `rowid` (the order
 * they were written in, as SQLite's own was) breaks a tie of the same instant.
 */
export const AUDIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ledger_audit_entries (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     at TEXT NOT NULL,
     by_id TEXT NOT NULL,
     action TEXT NOT NULL CHECK (action IN ('expense-recorded', 'expense-edited', 'expense-deleted')),
     subject_id TEXT NOT NULL,
     amount BIGINT NOT NULL,
     rowid BIGSERIAL
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_audit_entries_by_group ON ledger_audit_entries (group_id)`,
];
