import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The expenses and their shares, in the application's file, made by whoever opens it first. An expense's `version` is the
 * one it was last saved at: 1 when recorded, one more at each edit (ADR 8). Its `split_kind` is how it was split: equally,
 * by exact amounts or by shares; an expense kept before splits had kinds was split equally. Its shares are kept in the order
 * the split was given (`position`); an edit replaces them, and a deletion removes the expense and them.
 */
export function createLedgerTables(database: SqliteDatabase): void {
  database.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    spent_on TEXT NOT NULL,
    paid_by TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    split_kind TEXT NOT NULL DEFAULT 'equal',
    recorded_seq INTEGER NOT NULL DEFAULT 0
  )`);
  // A file made before expenses had a version: each of them is at version 1, the one it was recorded at. A file made before
  // splits had kinds: each of them was split equally. A file made before expenses had a recording order: each is ordered by
  // the position it was stored at, which is the order it was recorded in.
  const columns = database.all<{ name: string }>('PRAGMA table_info(expenses)');
  if (!columns.some(column => column.name === 'version')) {
    database.exec('ALTER TABLE expenses ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }
  if (!columns.some(column => column.name === 'split_kind')) {
    database.exec("ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'");
  }
  if (!columns.some(column => column.name === 'recorded_seq')) {
    database.exec('ALTER TABLE expenses ADD COLUMN recorded_seq INTEGER NOT NULL DEFAULT 0');
    database.exec('UPDATE expenses SET recorded_seq = rowid');
  }
  // What was paid in another currency (request 21): kept as given, and NULL for an expense in the group's currency, which is every
  // expense made before it.
  if (!columns.some(column => column.name === 'original_currency')) {
    database.exec('ALTER TABLE expenses ADD COLUMN original_currency TEXT');
    database.exec('ALTER TABLE expenses ADD COLUMN original_amount INTEGER');
    database.exec('ALTER TABLE expenses ADD COLUMN original_rate TEXT');
  }
  // Where the rate of an expense in another currency came from (request 22): stated by its payer, or taken from the rates service's
  // offer. NULL is stated, which is the source of every rate kept before offers.
  if (!columns.some(column => column.name === 'original_rate_source')) {
    database.exec('ALTER TABLE expenses ADD COLUMN original_rate_source TEXT');
  }
  // What an expense is for (request 24): one of the eight categories; an expense kept before categories is `other`.
  if (!columns.some(column => column.name === 'category')) {
    database.exec("ALTER TABLE expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  }
  database.exec('CREATE INDEX IF NOT EXISTS expenses_by_group ON expenses (group_id)');
  database.exec('CREATE INDEX IF NOT EXISTS expenses_by_group_category ON expenses (group_id, category)');
  database.exec(`CREATE TABLE IF NOT EXISTS expense_shares (
    expense_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    PRIMARY KEY (expense_id, position)
  )`);
  // The balances: a read model of the expenses, each one counted in the transaction that stores it (T4). A row is a
  // member's balance in a group; a member with nothing counted has no row, and reads as 0.
  database.exec(`CREATE TABLE IF NOT EXISTS member_balances (
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    balance INTEGER NOT NULL,
    PRIMARY KEY (group_id, member_id)
  )`);
  // The recurring expenses (request 23): what each is, kept as it was set up; `next_on` is the next day it records, and it is
  // the day the sweep asks for. `set_up_seq` is the order they were set up in, the earliest first.
  database.exec(`CREATE TABLE IF NOT EXISTS recurring_expenses (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    paid_by TEXT NOT NULL,
    description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    starts_on TEXT NOT NULL,
    next_on TEXT NOT NULL,
    split_kind TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    set_up_seq INTEGER NOT NULL DEFAULT 0
  )`);
  const recurringColumns = database.all<{ name: string }>('PRAGMA table_info(recurring_expenses)');
  if (!recurringColumns.some(column => column.name === 'category')) {
    database.exec("ALTER TABLE recurring_expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  }
  database.exec('CREATE INDEX IF NOT EXISTS recurring_expenses_by_group ON recurring_expenses (group_id)');
  database.exec('CREATE INDEX IF NOT EXISTS recurring_expenses_by_next ON recurring_expenses (next_on)');
  // The split as it was given: one row per member, in the order given. `amount` is an exact amount, `shares` a member's shares;
  // both are NULL for an equal split, which names only its members.
  database.exec(`CREATE TABLE IF NOT EXISTS recurring_expense_splits (
    recurring_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    amount INTEGER,
    shares INTEGER,
    PRIMARY KEY (recurring_id, position)
  )`);
  // The budgets (request 24): one per group and category. A removed budget stays as a row, `removed`, so the months it was passed in
  // are not forgotten if the owner sets it again; `version` is the aggregate's (ADR 8).
  database.exec(`CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    category TEXT NOT NULL,
    amount INTEGER NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (group_id, category)
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS budget_passed_months (
    budget_id TEXT NOT NULL,
    month TEXT NOT NULL,
    PRIMARY KEY (budget_id, month)
  )`);
  // The split templates (request 25): a split saved under a name in its group. A name is free in its group whatever its case, so
  // `name_key` is the name in lower case and is unique with the group; `saved_seq` is the order they were saved in, the earliest first.
  // `split_kind` is `equal` or `shares`; the members are kept in the order given, with their shares for a split by shares.
  database.exec(`CREATE TABLE IF NOT EXISTS split_templates (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    created_by TEXT NOT NULL,
    split_kind TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    saved_seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE (group_id, name_key)
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS split_template_members (
    template_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    shares INTEGER,
    PRIMARY KEY (template_id, position)
  )`);
}
