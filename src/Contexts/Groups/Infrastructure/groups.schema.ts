/**
 * The groups' tables in the SQLite file (ADR 2). A group's members are its rows of `group_members`, in the order they
 * joined (`position`), each with the moment it joined: the owner is the first, written with the group. `created_at`
 * orders the lists of groups, most recent first. An invitation is a row of `group_invitations`: its id is the link.
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
     PRIMARY KEY (group_id, account_id)
   )`,
  `CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)`,
  `CREATE TABLE IF NOT EXISTS group_invitations (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     invited_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
];
