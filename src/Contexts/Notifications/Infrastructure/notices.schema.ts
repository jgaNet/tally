import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The notifications' table in the SQLite file (ADR 2, ADR 11, ADR 12). A notice is one row, written once in the transaction
 * of the reaction or the sweep that makes it. A notice of an expense names it, and `(expense_id, member_id)` is unique: a
 * member is told of an expense once. A reminder names no expense (`expense_id` is NULL, and NULLs are never equal in a
 * unique index, so reminders do not collide). `at` is an ISO instant in UTC, so the latest first is the order of the text.
 */
export const NOTICE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notifications_notices (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     group_id TEXT NOT NULL,
     expense_id TEXT,
     kind TEXT NOT NULL CHECK (kind IN ('expense', 'reminder')),
     amount INTEGER NOT NULL,
     at TEXT NOT NULL,
     CHECK ((kind = 'expense') = (expense_id IS NOT NULL)),
     UNIQUE (expense_id, member_id)
   )`,
  `CREATE INDEX IF NOT EXISTS notifications_notices_by_member ON notifications_notices (member_id, at)`,
];

/**
 * Brings a file made by request 17 up to the table above: its `expense_id` was NOT NULL, which a reminder cannot store, and
 * the kind check named only `expense`. `CREATE TABLE IF NOT EXISTS` does not change a table that exists, so the table is
 * rebuilt once, in one transaction, keeping every row. A file made with this table is left as it is.
 */
export function migrateNotices(database: SqliteDatabase): void {
  const { connection } = database;
  const columns = connection.prepare('PRAGMA table_info(notifications_notices)').all() as {
    name: string;
    notnull: number;
  }[];
  if (columns.find(column => column.name === 'expense_id')?.notnull === 1) {
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec('DROP INDEX IF EXISTS notifications_notices_by_member');
      connection.exec('ALTER TABLE notifications_notices RENAME TO notifications_notices_before_reminders');
      database.migrate(NOTICE_STATEMENTS);
      connection.exec(
        `INSERT INTO notifications_notices (id, member_id, group_id, expense_id, kind, amount, at)
         SELECT id, member_id, group_id, expense_id, kind, amount, at FROM notifications_notices_before_reminders`,
      );
      connection.exec('DROP TABLE notifications_notices_before_reminders');
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }
  database.migrate(NOTICE_STATEMENTS);
}

/** The debt watches of the sweep (ADR 12): one row per member and group, with the optimistic version the sweep checks. */
export const DEBT_WATCH_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notifications_debt_watches (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     noted_since TEXT,
     last_reminded TEXT,
     version INTEGER NOT NULL,
     UNIQUE (group_id, member_id)
   )`,
];
