/**
 * The recurring expenses in the PostgreSQL database (request 23, ADR 16, ADR 22). A recurring expense is a row of `ledger_recurring_expenses`,
 * at its version; `next` is the day of its next expense, and a removed one (stopped or ended) has no rows. Its split is kept
 * as it was given: `split_kind` says which of the three, and each member is a row of `ledger_recurring_members`, in the order
 * given, with the amount or the shares it was given with (null for an equal split). `rowid` is the order they were set up in, as SQLite's own was.
 */
export const RECURRING_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ledger_recurring_expenses (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     paid_by TEXT NOT NULL,
     description TEXT NOT NULL,
     amount BIGINT NOT NULL,
     starts_on TEXT NOT NULL,
     next TEXT NOT NULL,
     split_kind TEXT NOT NULL CHECK (split_kind IN ('equal', 'exact', 'shares')),
     set_up_at TEXT NOT NULL,
     version BIGINT NOT NULL,
     rowid BIGSERIAL
   )`,
  `CREATE INDEX IF NOT EXISTS ledger_recurring_expenses_by_next ON ledger_recurring_expenses (next)`,
  `CREATE INDEX IF NOT EXISTS ledger_recurring_expenses_by_group ON ledger_recurring_expenses (group_id)`,
  /*
   * What each expense of a recurring expense is filed under (request 24): a side table, as the expenses' categories are. The
   * recurring expenses set up before categories existed are `other`, given once; a row already there is kept.
   */
  `CREATE TABLE IF NOT EXISTS ledger_recurring_categories (
     recurring_id TEXT PRIMARY KEY,
     category TEXT NOT NULL CHECK (category IN ('groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other'))
   )`,
  `INSERT INTO ledger_recurring_categories (recurring_id, category)
   SELECT id, 'other' FROM ledger_recurring_expenses
   ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS ledger_recurring_members (
     recurring_id TEXT NOT NULL,
     position BIGINT NOT NULL,
     member_id TEXT NOT NULL,
     given BIGINT,
     PRIMARY KEY (recurring_id, position)
   )`,
];
