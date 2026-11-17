import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { GroupView, IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { Group, GroupMember, GroupSnapshot } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';

/**
 * The groups' tables (ADR 2, ADR 5). A group's members are rows of `group_members`, in the order they joined (`position`,
 * the owner first) with the time each joined (feature 3). A group's `version` is the one the aggregate is stored at
 * (ADR 8). `created_at` is an ISO 8601 UTC string, so it sorts as time does.
 */
export const groupsTablesSchema = [
  `CREATE TABLE IF NOT EXISTS groups (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     currency TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS group_members (
     group_id TEXT NOT NULL REFERENCES groups(id),
     account_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     joined_at TEXT NOT NULL,
     PRIMARY KEY (group_id, account_id)
   )`,
  'CREATE INDEX IF NOT EXISTS group_members_by_account ON group_members (account_id)',
];

/**
 * The groups in SQLite. Its reads go to the committed data, and its writes to the transaction that holds the writer (the
 * command adds or saves a group inside its transaction). A member sees a group only through its membership row, so the
 * join is what decides who may see it.
 *
 * `save` is the optimistic check the way SQL makes it atomic (ADR 8, as the reference does it): the group's row is
 * updated only while it is still at the version the aggregate was loaded at, and the members are added after that. A
 * group that another writer changed first is refused with a ConcurrencyConflictException.
 */
export class SqliteGroupStore implements IGroupStore, IGroupRoster {
  constructor(private readonly database: SqliteDatabase) {}

  async add(group: Group): Promise<void> {
    const snapshot = group.toSnapshot();
    this.database.writer
      .prepare('INSERT INTO groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(snapshot.id, snapshot.name, snapshot.currency, snapshot.ownerId, snapshot.createdAt, snapshot.version + 1);
    this.#addMembers(snapshot);
  }

  async findById(groupId: string): Promise<Group | undefined> {
    const row = this.database.read(db =>
      db.prepare('SELECT id, name, currency, owner_id, created_at, version FROM groups WHERE id = ?').get(groupId),
    ) as GroupRow | undefined;
    if (!row) return undefined;

    const members = this.database.read(db =>
      db.prepare('SELECT account_id, joined_at FROM group_members WHERE group_id = ? ORDER BY position').all(groupId),
    ) as unknown as MemberRow[];
    return Group.fromSnapshot({
      id: row.id,
      name: row.name,
      currency: row.currency,
      ownerId: row.owner_id,
      members: members.map(toMember),
      createdAt: row.created_at,
      version: row.version,
    });
  }

  async save(group: Group): Promise<void> {
    const snapshot = group.toSnapshot();
    const { changes } = this.database.writer
      .prepare('UPDATE groups SET version = ? WHERE id = ? AND version = ?')
      .run(snapshot.version + 1, snapshot.id, snapshot.version);
    if (changes === 0) {
      throw new ConcurrencyConflictException('Groups', 'The group changed since it was read: read it again');
    }
    this.#addMembers(snapshot);
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
    ) as GroupViewRow | undefined;
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
    ) as unknown as GroupViewRow[];
    return rows.map(toView);
  }

  async membersOf(groupId: string): Promise<string[] | undefined> {
    const rows = this.database.read(db =>
      db.prepare('SELECT account_id FROM group_members WHERE group_id = ? ORDER BY position').all(groupId),
    ) as unknown as { account_id: string }[];
    return rows.length > 0 ? rows.map(row => row.account_id) : undefined;
  }

  /** Adds the members that are not stored yet: the ones already there keep the row they were given (`position` is theirs). */
  #addMembers(snapshot: GroupSnapshot): void {
    snapshot.members.forEach((member: GroupMember, position) => {
      this.database.writer
        .prepare('INSERT OR IGNORE INTO group_members (group_id, account_id, position, joined_at) VALUES (?, ?, ?, ?)')
        .run(snapshot.id, member.accountId, position, member.joinedAt);
    });
  }
}

interface GroupRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  created_at: string;
  version: number;
}

interface GroupViewRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
}

interface MemberRow {
  account_id: string;
  joined_at: string;
}

const toView = (row: GroupViewRow): GroupView => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
});

const toMember = (row: MemberRow): GroupMember => ({ accountId: row.account_id, joinedAt: row.joined_at });
