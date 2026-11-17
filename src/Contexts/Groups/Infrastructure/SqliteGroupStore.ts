import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { GroupView, IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { Group } from '@Contexts/Groups/Domain/Group/Group';

/**
 * The groups' tables (ADR 2, ADR 5). A group's members are rows of `group_members`, the owner first; a member is in the
 * table from the creation, and feature 3 adds the rest. `created_at` is an ISO 8601 UTC string, so it sorts as time does.
 */
export const groupsTablesSchema = [
  `CREATE TABLE IF NOT EXISTS groups (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     currency TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS group_members (
     group_id TEXT NOT NULL REFERENCES groups(id),
     account_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     PRIMARY KEY (group_id, account_id)
   )`,
  'CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)',
];

/**
 * The groups in SQLite. Its reads go to the committed data, and its writes to the transaction that holds the writer (the
 * command adds a group inside its transaction). A member sees a group only through its membership row, so the join is
 * what decides who may see it.
 */
export class SqliteGroupStore implements IGroupStore {
  constructor(private readonly database: SqliteDatabase) {}

  async add(group: Group): Promise<void> {
    const snapshot = group.toSnapshot();
    const writer = this.database.writer;
    writer
      .prepare('INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(snapshot.id, snapshot.name, snapshot.currency, snapshot.ownerId, snapshot.createdAt);
    snapshot.memberIds.forEach((accountId, position) => {
      writer
        .prepare('INSERT INTO group_members (group_id, account_id, position) VALUES (?, ?, ?)')
        .run(snapshot.id, accountId, position);
    });
  }

  async viewFor(groupId: string, memberId: string): Promise<GroupView | undefined> {
    const row = this.database.read(db =>
      db
        .prepare(
          `SELECT g.id, g.name, g.currency, g.owner_id FROM groups g
           JOIN group_members m ON m.group_id = g.id
           WHERE g.id = ? AND m.account_id = ?`,
        )
        .get(groupId, memberId),
    ) as GroupRow | undefined;
    return row && toView(row);
  }

  async listFor(memberId: string): Promise<GroupView[]> {
    const rows = this.database.read(db =>
      db
        .prepare(
          `SELECT g.id, g.name, g.currency, g.owner_id FROM groups g
           JOIN group_members m ON m.group_id = g.id
           WHERE m.account_id = ?
           ORDER BY g.created_at DESC, g.rowid DESC`,
        )
        .all(memberId),
    ) as unknown as GroupRow[];
    return rows.map(toView);
  }
}

interface GroupRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
}

const toView = (row: GroupRow): GroupView => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
});
