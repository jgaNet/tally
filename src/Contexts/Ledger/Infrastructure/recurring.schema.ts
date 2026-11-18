/**
 * The recurring expenses in the SQLite file (request 23, ADR 16). A recurring expense is a row of `ledger_recurring_expenses`,
 * at its version; `next` is the day of its next expense, and a removed one (stopped or ended) has no rows. Its split is kept
 * as it was given: `split_kind` says which of the three, and each member is a row of `ledger_recurring_members`, in the order
 * given, with the amount or the shares it was given with (null for an equal split).
 */
export const RECURRING_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ledger_recurring_expenses (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     paid_by TEXT NOT NULL,
     description TEXT NOT NULL,
     amount INTEGER NOT NULL,
     starts_on TEXT NOT NULL,
     next TEXT NOT NULL,
     split_kind TEXT NOT NULL CHECK (split_kind IN ('equal', 'exact', 'shares')),
     set_up_at TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_recurring_expenses_by_next ON ledger_recurring_expenses (next)`,
  `CREATE INDEX IF NOT EXISTS ledger_recurring_expenses_by_group ON ledger_recurring_expenses (group_id)`,
  `CREATE TABLE IF NOT EXISTS ledger_recurring_members (
     recurring_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     member_id TEXT NOT NULL,
     given INTEGER,
     PRIMARY KEY (recurring_id, position)
   )`,
];
