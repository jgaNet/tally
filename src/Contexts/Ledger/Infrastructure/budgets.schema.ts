/**
 * The budgets in the SQLite file (request 24). A budget is one row of `ledger_budgets` per group and category, at its version;
 * `active` says whether it limits its category (a removed one stays, with the months it was passed in, in `passed_months`, a
 * JSON array of `YYYY-MM`), so that a month is told once whatever is set or removed after it.
 */
export const BUDGET_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ledger_budgets (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     category TEXT NOT NULL CHECK (category IN ('groceries', 'rent', 'utilities', 'transport', 'food', 'travel', 'leisure', 'other')),
     amount INTEGER NOT NULL,
     active INTEGER NOT NULL CHECK (active IN (0, 1)),
     passed_months TEXT NOT NULL,
     version INTEGER NOT NULL,
     UNIQUE (group_id, category)
   )`,
];
