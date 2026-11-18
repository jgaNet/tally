import { DatabaseSync } from 'node:sqlite';

/**
 * The Notifications schema steps of the SQLite file an earlier version of Tally kept, run in the order that version ran them:
 * the notices (with the columns a budget's notice added), then the debt watches. Used only to move that file into the database
 * (Bootstrap/Database/moveSqliteFile.ts); nothing else runs them.
 */
export function upgradeNotificationsFile(connection: DatabaseSync): void {
  connection.exec(
    'CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, group_id TEXT NOT NULL, expense_id TEXT, amount INTEGER NOT NULL, at TEXT NOT NULL, UNIQUE (account_id, expense_id))',
  );
  // A file made before budgets (request 24) has none of these columns: a budget's notice names its category, month and budget.
  const columns = (connection.prepare('PRAGMA table_info(notices)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  for (const [name, type] of [
    ['category', 'TEXT'],
    ['month', 'TEXT'],
    ['budget', 'INTEGER'],
    ['budget_key', 'TEXT'],
  ] as const) {
    if (!columns.includes(name)) connection.exec(`ALTER TABLE notices ADD COLUMN ${name} ${type}`);
  }
  connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS notices_by_budget ON notices (account_id, budget_key)');

  connection.exec(
    'CREATE TABLE IF NOT EXISTS debt_watches (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL, noted_since TEXT, last_reminded_at TEXT, version INTEGER NOT NULL, UNIQUE (account_id, group_id))',
  );
}
