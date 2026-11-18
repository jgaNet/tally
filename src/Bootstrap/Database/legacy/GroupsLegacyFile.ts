import type { DatabaseSync } from 'node:sqlite';

/**
 * The Groups' schema steps as the SQLite version of Tally ran them when it opened a file (docs/adr/0029), verbatim and in
 * their order: the accounts, the secrets, the groups and their members and balances, then the invitations. The ALTER steps
 * and the joined dates' backfill bring a file from an earlier version to the shape the current version reads. The
 * session key is not here: it is a seed of the database, made after the move, so a file's own key is kept. Each adapter
 * of the SQLite version ran its step again on opening; a second run of an idempotent step changes nothing, so each runs once.
 */
export function upgradeGroupsFile(connection: DatabaseSync): void {
  // SqliteAccountRepository, SqliteAccountQueries.
  connection.exec(
    'CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, version INTEGER NOT NULL)',
  );

  // SqliteSessionTokens: the table only.
  connection.exec('CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)');

  // SqliteGroupRepository, SqliteGroupQueries: prepareGroupsSchema.
  const groupsSchema = [
    'CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES groups (id), account_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, joined_at TEXT NOT NULL, left_at TEXT, passed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (group_id, account_id))',
    'CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)',
    // The balances that passed to the owner when a member left, one row each, never changed: the group's audit (request 28, docs/adr/0027).
    'CREATE TABLE IF NOT EXISTS passed_balances (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, at TEXT NOT NULL)',
  ].join(';\n');
  connection.exec(groupsSchema);
  // Before a group could be archived (request 27, docs/adr/0026): there, no group is archived.
  const groupColumns = (connection.prepare('PRAGMA table_info(groups)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  if (!groupColumns.includes('archived_at')) connection.exec('ALTER TABLE groups ADD COLUMN archived_at TEXT');
  const columns = (connection.prepare('PRAGMA table_info(group_members)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  // Before members had their join dates (feature 2): there, every member is an owner, who joined when its group was created.
  if (!columns.includes('joined_at')) {
    connection.exec(
      "ALTER TABLE group_members ADD COLUMN joined_at TEXT NOT NULL DEFAULT ''; UPDATE group_members SET joined_at = (SELECT created_at FROM groups WHERE groups.id = group_members.group_id)",
    );
  }
  // Before members could leave (request 9): there, no membership has left.
  if (!columns.includes('left_at')) connection.exec('ALTER TABLE group_members ADD COLUMN left_at TEXT');
  // Before a leave passed its balance to the owner (request 20, docs/adr/0019): there, nothing has passed.
  if (!columns.includes('passed'))
    connection.exec('ALTER TABLE group_members ADD COLUMN passed INTEGER NOT NULL DEFAULT 0');

  // SqliteInvitationRepository, SqliteInvitationQueries.
  connection.exec(
    'CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups (id), invited_by TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL)',
  );
}
