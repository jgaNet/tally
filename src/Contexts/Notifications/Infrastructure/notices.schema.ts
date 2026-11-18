/**
 * The notifications' table in the PostgreSQL database (ADR 22, ADR 11, ADR 12). A notice is one row, written once in the
 * transaction of the reaction or the sweep that makes it. A notice of an expense names it, and `(expense_id, member_id)` is
 * unique: a member is told of an expense once. A reminder names no expense (`expense_id` is NULL, and NULLs are never equal
 * in a unique index, so reminders do not collide). `at` is an ISO instant in UTC, so the latest first is the order of the
 * text, and `rowid` (the order they were written in, as SQLite's own was) breaks a tie. The table is created in its final
 * shape: a file made by request 17 or 18 had fewer columns, and the move copies the columns it has.
 */
export const NOTICE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notifications_notices (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     group_id TEXT NOT NULL,
     expense_id TEXT,
     kind TEXT NOT NULL CHECK (kind IN ('expense', 'reminder', 'budget')),
     amount BIGINT NOT NULL,
     at TEXT NOT NULL,
     category TEXT,
     month TEXT,
     budget BIGINT,
     rowid BIGSERIAL,
     CHECK ((kind = 'expense') = (expense_id IS NOT NULL)),
     CHECK ((kind = 'budget') = (category IS NOT NULL AND month IS NOT NULL AND budget IS NOT NULL)),
     UNIQUE (expense_id, member_id)
   )`,
  `CREATE INDEX IF NOT EXISTS notifications_notices_by_member ON notifications_notices (member_id, at)`,
  // Notices moved with their own `rowid`: the sequence is taken past them, so a notice written after the move comes after
  // them. It only ever moves forward.
  `SELECT setval(pg_get_serial_sequence('notifications_notices', 'rowid'), MAX(rowid))
     FROM notifications_notices
   HAVING MAX(rowid) >= (SELECT last_value FROM notifications_notices_rowid_seq)`,
];

/** The debt watches of the sweep (ADR 12): one row per member and group, with the optimistic version the sweep checks. */
export const DEBT_WATCH_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notifications_debt_watches (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     noted_since TEXT,
     last_reminded TEXT,
     version BIGINT NOT NULL,
     UNIQUE (group_id, member_id)
   )`,
];
