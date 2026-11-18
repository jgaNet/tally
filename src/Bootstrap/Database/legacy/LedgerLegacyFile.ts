import type { DatabaseSync } from 'node:sqlite';

/**
 * The Ledger context's schema steps as the SQLite file an earlier version of Tally kept ran them on opening it, verbatim and in
 * the order the adapters registered them: the expenses and their shares (with the columns added since), the recurring expenses,
 * the budgets, the split templates, the receipts, and the audit of the changes of money. Self-contained: it is the only Ledger
 * code that talks to SQLite, and it runs only when a file is moved into the database (Bootstrap/Database/moveSqliteFile.ts).
 */

const LEDGER_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL, paid_by TEXT NOT NULL, split_kind TEXT NOT NULL DEFAULT 'equal', version INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS expense_shares (expense_id TEXT NOT NULL REFERENCES expenses (id), position INTEGER NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (expense_id, position))',
].join(';\n');

const ORIGINAL_COLUMNS = [
  ['original_currency', 'TEXT'],
  ['original_amount', 'INTEGER'],
  ['original_rate', 'TEXT'],
] as const;

const LEDGER_AUDIT_SCHEMA =
  'CREATE TABLE IF NOT EXISTS audit_entries (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, at TEXT NOT NULL, by_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL, amount INTEGER NOT NULL)';

const RECURRING_SCHEMA =
  "CREATE TABLE IF NOT EXISTS recurring_expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, paid_by TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, starts_on TEXT NOT NULL, next TEXT NOT NULL, split_json TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', version INTEGER NOT NULL)";

const BUDGET_SCHEMA =
  "CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, category TEXT NOT NULL, amount INTEGER, passed_months TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL, UNIQUE (group_id, category))";

const SPLIT_TEMPLATE_SCHEMA =
  'CREATE TABLE IF NOT EXISTS split_templates (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, created_by TEXT NOT NULL, split TEXT NOT NULL, version INTEGER NOT NULL, UNIQUE (group_id, name_key))';

const RECEIPT_SCHEMA =
  'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, expense_id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, url TEXT NOT NULL, attached_by TEXT NOT NULL, version INTEGER NOT NULL)';

/** Brings a Ledger table of the SQLite file to the shape the version that wrote it, and the current one, read. */
export function upgradeLedgerFile(connection: DatabaseSync): void {
  // prepareLedgerSchema: the expenses and their shares, then the columns a file made before them lacks.
  connection.exec(LEDGER_SCHEMA);
  const columns = (connection.prepare('PRAGMA table_info(expenses)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  if (!columns.includes('split_kind')) {
    connection.exec("ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'");
  }
  // The expenses recorded before categories (request 24) are `other`, the default the column takes.
  if (!columns.includes('category')) {
    connection.exec("ALTER TABLE expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  }
  for (const [name, type] of ORIGINAL_COLUMNS) {
    if (!columns.includes(name)) connection.exec(`ALTER TABLE expenses ADD COLUMN ${name} ${type}`);
  }
  // The instant each expense was recorded (request 29, docs/adr/0028): an expense recorded before it was kept has '', which sorts first on its day.
  if (!columns.includes('recorded_at'))
    connection.exec("ALTER TABLE expenses ADD COLUMN recorded_at TEXT NOT NULL DEFAULT ''");
  // The group's audit of the changes of money (request 28, docs/adr/0027).
  connection.exec(LEDGER_AUDIT_SCHEMA);

  // prepareRecurringSchema
  connection.exec(RECURRING_SCHEMA);
  const recurringColumns = (
    connection.prepare('PRAGMA table_info(recurring_expenses)').all() as Array<{ name: string }>
  ).map(column => column.name);
  if (!recurringColumns.includes('category')) {
    connection.exec("ALTER TABLE recurring_expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  }

  // prepareBudgetSchema
  connection.exec(BUDGET_SCHEMA);

  // prepareSplitTemplateSchema
  connection.exec(SPLIT_TEMPLATE_SCHEMA);

  // prepareReceiptSchema
  connection.exec(RECEIPT_SCHEMA);

  // prepareAuditSchema (registered again by the audit's queries: the same statement, run again, changes nothing)
  connection.exec(LEDGER_AUDIT_SCHEMA);
}
