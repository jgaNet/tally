import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { GroupView, IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { FormerMember, Group, GroupMember, GroupSnapshot } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRoster, RosterMember } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';

/**
 * The groups' tables (ADR 2, ADR 5). A group's members are rows of `group_members`, in the order they joined (`position`,
 * the owner first) with the time each joined (feature 3). A member who left (feature 9) is a row of `group_former_members`
 * instead, with the time they left: the group's roster reads only the members now, and `hasBeenMember` reads both. A
 * group's `version` is the one the aggregate is stored at (ADR 8). `created_at` is an ISO 8601 UTC string, so it sorts as
 * time does.
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
  `CREATE TABLE IF NOT EXISTS group_former_members (
     group_id TEXT NOT NULL REFERENCES groups(id),
     account_id TEXT NOT NULL,
     joined_at TEXT NOT NULL,
     left_at TEXT NOT NULL,
     PRIMARY KEY (group_id, account_id)
   )`,
];

/**
 * The groups in SQLite. Its reads go to the committed data, and its writes to the transaction that holds the writer (the
 * command adds or saves a group inside its transaction). A member sees a group only through its membership row, so the
 * join is what decides who may see it, and a member who left has none (feature 9).
 *
 * `save` is the optimistic check the way SQL makes it atomic (ADR 8, as the reference does it): the group's row is
 * updated only while it is still at the version the aggregate was loaded at, and the members are written after that. A
 * group that another writer changed first is refused with a ConcurrencyConflictException.
 */
export class SqliteGroupStore implements IGroupStore, IGroupRoster {
  constructor(private readonly database: SqliteDatabase) {}

  async add(group: Group): Promise<void> {
    const snapshot = group.toSnapshot();
    this.database.writer
      .prepare('INSERT INTO groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?)')
      .run(snapshot.id, snapshot.name, snapshot.currency, snapshot.ownerId, snapshot.createdAt, snapshot.version + 1);
    this.#saveMembers(snapshot);
  }

  async findById(groupId: string): Promise<Group | undefined> {
    const row = this.database.read(db =>
      db.prepare('SELECT id, name, currency, owner_id, created_at, version FROM groups WHERE id = ?').get(groupId),
    ) as GroupRow | undefined;
    if (!row) return undefined;

    const members = this.database.read(db =>
      db.prepare('SELECT account_id, joined_at FROM group_members WHERE group_id = ? ORDER BY position').all(groupId),
    ) as unknown as MemberRow[];
    const formerMembers = this.database.read(db =>
      db
        .prepare('SELECT account_id, joined_at, left_at FROM group_former_members WHERE group_id = ? ORDER BY left_at')
        .all(groupId),
    ) as unknown as FormerMemberRow[];
    return Group.fromSnapshot({
      id: row.id,
      name: row.name,
      currency: row.currency,
      ownerId: row.owner_id,
      members: members.map(toMember),
      formerMembers: formerMembers.map(toFormerMember),
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
    this.#saveMembers(snapshot);
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

  async membersOf(groupId: string): Promise<RosterMember[] | undefined> {
    const rows = this.database.read(db =>
      db
        .prepare(
          `SELECT m.account_id, CASE WHEN m.account_id = g.owner_id THEN 'owner' ELSE 'member' END AS role
             FROM group_members m JOIN groups g ON g.id = m.group_id
            WHERE m.group_id = ? ORDER BY m.position`,
        )
        .all(groupId),
    ) as unknown as RosterRow[];
    return rows.length > 0 ? rows.map(row => ({ memberId: row.account_id, role: row.role })) : undefined;
  }

  async currencyOf(groupId: string): Promise<string | undefined> {
    const row = this.database.read(db => db.prepare('SELECT currency FROM groups WHERE id = ?').get(groupId)) as
      { currency: string } | undefined;
    return row?.currency;
  }

  async groupIds(): Promise<string[]> {
    const rows = this.database.read(db => db.prepare('SELECT id FROM groups ORDER BY rowid').all()) as { id: string }[];
    return rows.map(row => row.id);
  }

  async hasBeenMember(groupId: string, accountId: string): Promise<boolean> {
    const row = this.database.read(db =>
      db
        .prepare(
          `SELECT 1 AS found FROM group_members WHERE group_id = ? AND account_id = ?
           UNION ALL
           SELECT 1 AS found FROM group_former_members WHERE group_id = ? AND account_id = ?
           LIMIT 1`,
        )
        .get(groupId, accountId, groupId, accountId),
    );
    return row !== undefined;
  }

  /**
   * Writes the members as the aggregate holds them now. Each member now is a row of `group_members` at its place in the
   * order (a member who joined again leaves its former row); each former member is a row of `group_former_members` and
   * no longer one of `group_members`. Idempotent: what is stored already is written again as it is.
   */
  #saveMembers(snapshot: GroupSnapshot): void {
    snapshot.members.forEach((member: GroupMember, position) => {
      this.database.writer
        .prepare('DELETE FROM group_former_members WHERE group_id = ? AND account_id = ?')
        .run(snapshot.id, member.accountId);
      this.database.writer
        .prepare(
          `INSERT INTO group_members (group_id, account_id, position, joined_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (group_id, account_id) DO UPDATE SET position = excluded.position, joined_at = excluded.joined_at`,
        )
        .run(snapshot.id, member.accountId, position, member.joinedAt);
    });
    snapshot.formerMembers.forEach((member: FormerMember) => {
      this.database.writer
        .prepare('DELETE FROM group_members WHERE group_id = ? AND account_id = ?')
        .run(snapshot.id, member.accountId);
      this.database.writer
        .prepare(
          `INSERT INTO group_former_members (group_id, account_id, joined_at, left_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (group_id, account_id) DO UPDATE SET joined_at = excluded.joined_at, left_at = excluded.left_at`,
        )
        .run(snapshot.id, member.accountId, member.joinedAt, member.leftAt);
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

interface RosterRow {
  account_id: string;
  role: 'owner' | 'member';
}

interface MemberRow {
  account_id: string;
  joined_at: string;
}

interface FormerMemberRow {
  account_id: string;
  joined_at: string;
  left_at: string;
}

const toView = (row: GroupViewRow): GroupView => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
});

const toMember = (row: MemberRow): GroupMember => ({ accountId: row.account_id, joinedAt: row.joined_at });

const toFormerMember = (row: FormerMemberRow): FormerMember => ({
  accountId: row.account_id,
  joinedAt: row.joined_at,
  leftAt: row.left_at,
});
