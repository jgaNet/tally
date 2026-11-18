import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { createAccountsTable } from '@Contexts/Groups/Infrastructure/AccountsTable';

/**
 * The groups, their members and their invitations, made once by whoever prepares the database first; every adapter over them
 * asks for it. A member's row is kept in join order (`position`), so that the owner, the first, is the first row, and
 * with the time it joined. A group's `version` is the one it was last saved at (ADR 8).
 *
 * A member who left keeps its row, with the time it left (`left_at`, ADR 4): a row with no `left_at` is a current member.
 *
 * A file made before the members had their join time and the groups their version is brought up to date when it is moved
 * into the database (ADR 30): each member of such a file was the owner, who joined when the group was created.
 */
export function createGroupsTables(database: PostgresDatabase): void {
  createAccountsTable(database);
  database.declare(`CREATE TABLE IF NOT EXISTS groups (
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    currency TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT
  )`);
  database.declare(`CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    joined_at TEXT NOT NULL DEFAULT '',
    left_at TEXT,
    PRIMARY KEY (group_id, account_id)
  )`);
  database.declare('CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)');
  database.declare(`CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    invited_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  // The balances passed to the owner when members left (request 20), in the order they passed: kept for good.
  // The audit of the money Groups moves (request 28): the balance a member passed to the owner when they left, with the leave's time.
  // Its id names the leave, and a member leaves a group once, so an id is written once.
  database.declare(`CREATE TABLE IF NOT EXISTS group_audit_entries (
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    at TEXT NOT NULL,
    by_account TEXT NOT NULL,
    action TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    amount INTEGER NOT NULL
  )`);
  database.declare('CREATE INDEX IF NOT EXISTS group_audit_by_group ON group_audit_entries (group_id)');
  // The administrators' log entries Groups writes (request 34): a suspension or a reinstatement, with the administrator and the time.
  database.declare(`CREATE TABLE IF NOT EXISTS administrator_log_entries (
    seq BIGSERIAL,
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    by_account TEXT NOT NULL,
    action TEXT NOT NULL,
    subject_id TEXT NOT NULL
  )`);
  database.declare(`CREATE TABLE IF NOT EXISTS balance_passages (
    group_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    from_account_id TEXT NOT NULL,
    to_account_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    PRIMARY KEY (group_id, position)
  )`);
}
