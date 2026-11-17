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
  /*
   * The balances' read model (ADR 1, T4): one row per member per expense, the member's net of that expense: what they
   * paid of it minus their share. Written in the transaction that records the expense, and never changed after, so the
   * balances are sums over rows nobody updates, and the expenses of a group add up to 0 row by row.
   */
  `CREATE TABLE IF NOT EXISTS ledger_balance_entries (
     expense_id TEXT NOT NULL,
     group_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     PRIMARY KEY (expense_id, member_id)
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_balance_entries_by_group ON ledger_balance_entries (group_id, member_id)`,
  /*
   * Expenses recorded before the entries existed get theirs once: the same net per member, from the expense and its
   * shares. Ignoring a row already there makes it safe to run again on every start.
   */
  `INSERT OR IGNORE INTO ledger_balance_entries (expense_id, group_id, member_id, amount)
   SELECT expense_id, group_id, member_id, SUM(amount) FROM (
     SELECT id AS expense_id, group_id, paid_by AS member_id, amount FROM ledger_expenses
     UNION ALL
     SELECT s.expense_id, e.group_id, s.member_id, -s.amount
       FROM ledger_expense_shares s JOIN ledger_expenses e ON e.id = s.expense_id
   ) GROUP BY expense_id, member_id`,
];
