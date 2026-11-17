/**
 * The notifications' table in the SQLite file (ADR 2, ADR 11). A notice is one row, written once in the transaction of the
 * reaction that makes it. `(expense_id, member_id)` is unique: a member is told of an expense once. `at` is an ISO instant
 * in UTC, so the latest first is the order of the text.
 */
export const NOTICE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notifications_notices (
     id TEXT PRIMARY KEY,
     member_id TEXT NOT NULL,
     group_id TEXT NOT NULL,
     expense_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('expense')),
     amount INTEGER NOT NULL,
     at TEXT NOT NULL,
     UNIQUE (expense_id, member_id)
   )`,
  `CREATE INDEX IF NOT EXISTS notifications_notices_by_member ON notifications_notices (member_id, at)`,
];
