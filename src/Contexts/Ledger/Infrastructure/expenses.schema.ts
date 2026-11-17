/**
 * The ledger's tables in the SQLite file (ADR 2). An expense is a row of `ledger_expenses`; its shares are its rows of
 * `ledger_expense_shares`, in the order of the split (`position`). `recorded_at` is when it was recorded; nothing here
 * changes after that.
 */
export const EXPENSE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ledger_expenses (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     description TEXT NOT NULL,
     amount INTEGER NOT NULL,
     date TEXT NOT NULL,
     paid_by TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_expenses_by_group ON ledger_expenses (group_id)`,
  `CREATE TABLE IF NOT EXISTS ledger_expense_shares (
     expense_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     member_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     PRIMARY KEY (expense_id, position)
   )`,
];
