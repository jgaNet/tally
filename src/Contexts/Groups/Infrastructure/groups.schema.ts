/**
 * The groups' tables in the SQLite file (ADR 2). A group's memberships are its rows of `group_members`, in the order they
 * joined (`position`), each with the moment it joined and, once it has left, the moment it left (`left_at`, null while it
 * is a member): the owner is the first, written with the group, and never leaves. `created_at` orders the lists of
 * groups, most recent first. An invitation is a row of `group_invitations`: its id is the link.
 */
export const GROUP_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tally_groups (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     currency TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS group_members (
     group_id TEXT NOT NULL,
     account_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     joined_at TEXT NOT NULL,
     left_at TEXT,
     PRIMARY KEY (group_id, account_id)
   )`,
  `CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)`,
  // The balances that passed to the owner when a member left (request 20, ADR 13): facts, one per leave, in the order they
  // were made. They outlive the membership of the member who left, which a new join replaces.
  `CREATE TABLE IF NOT EXISTS group_balances_passed (
     group_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     from_id TEXT NOT NULL,
     to_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     passed_at TEXT NOT NULL,
     PRIMARY KEY (group_id, position)
   )`,
  // The moment a group was archived (request 27, ADR 20): a fact, written once, and never undone. A group without a row is open.
  `CREATE TABLE IF NOT EXISTS group_archives (
     group_id TEXT PRIMARY KEY,
     archived_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS group_invitations (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     invited_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
];
