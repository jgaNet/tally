import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Group, GroupSnapshot } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRepository } from '@Contexts/Groups/Application/IGroupRepository';
import { GroupView, IGroupQueries, MemberView } from '@Contexts/Groups/Domain/IGroupQueries';

import { GroupsDatabase } from './GroupsDatabase';

type GroupRow = { id: string; name: string; currency: string; owner_id: string; created_at: string; version: number };
type MemberRow = { account_id: string; joined_at: string };

const GROUP_COLUMNS = 'g.id, g.name, g.currency, g.owner_id';
const MEMBER_OF_GROUP = 'JOIN expense_group_members m ON m.group_id = g.id';
/**
 * When a member joined. A membership an older build wrote, while a server of it still shares the file, carries no time:
 * it joined when its group was created, which is the only membership such a build writes (the owner's).
 */
const JOINED_AT = "COALESCE(NULLIF(m.joined_at, ''), g.created_at)";

const viewOf = (row: Pick<GroupRow, 'id' | 'name' | 'currency' | 'owner_id'>): GroupView => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
});

/**
 * The groups in SQLite: the repository `CreateGroup` inserts into and `AcceptInvitation` loads and saves, and the read side
 * `GetGroup`, `GetMyGroups` and `GetGroupMembers` read. A group and its members are written in one transaction, so a group
 * always has its first member. A save is conditional on the version the group was read at (CONC-OPTIMISTIC, ADR 4).
 */
export class SqliteGroups implements IGroupRepository, IGroupQueries {
  constructor(private readonly database: GroupsDatabase) {}

  async insert(group: Group): Promise<void> {
    const { id, name, currency, ownerId, createdAt, members } = group.toSnapshot();
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection
        .prepare(
          'INSERT INTO expense_groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, name, currency, ownerId, createdAt, group.version + 1);
      this.insertMembers(id, members);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async get(id: string): Promise<Group | undefined> {
    const connection = this.database.connection;
    const row = connection
      .prepare('SELECT id, name, currency, owner_id, created_at, version FROM expense_groups WHERE id = ?')
      .get(id) as GroupRow | undefined;
    if (!row) return undefined;
    const members = connection
      .prepare(
        `SELECT m.account_id, ${JOINED_AT} AS joined_at
           FROM expense_group_members m JOIN expense_groups g ON g.id = m.group_id
          WHERE m.group_id = ?
          ORDER BY ${JOINED_AT}, m.rowid`,
      )
      .all(id) as MemberRow[];
    const snapshot: GroupSnapshot = {
      id: row.id,
      name: row.name,
      currency: row.currency as GroupSnapshot['currency'],
      ownerId: row.owner_id,
      createdAt: row.created_at,
      members: members.map(member => ({ accountId: member.account_id, joinedAt: member.joined_at })),
      version: row.version,
    };
    return Group.fromSnapshot(snapshot);
  }

  async save(group: Group): Promise<void> {
    const { id, members } = group.toSnapshot();
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      const updated = connection
        .prepare('UPDATE expense_groups SET version = ? WHERE id = ? AND version = ?')
        .run(group.version + 1, id, group.version);
      if (updated.changes !== 1) {
        throw new ConcurrencyConflictException('Groups', 'The group changed since it was read');
      }
      // The members stored are kept as they are, except those who left since the read: they are removed. Those who joined
      // since the read are inserted; a member who left and joins again is inserted again, last.
      const kept = members.map(member => member.accountId);
      connection
        .prepare(
          `DELETE FROM expense_group_members WHERE group_id = ? AND account_id NOT IN (${kept.map(() => '?').join(', ')})`,
        )
        .run(id, ...kept);
      this.insertMembers(id, members);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async groupOf(id: string, memberId: string): Promise<GroupView | undefined> {
    const row = this.database.connection
      .prepare(`SELECT ${GROUP_COLUMNS} FROM expense_groups g ${MEMBER_OF_GROUP} WHERE g.id = ? AND m.account_id = ?`)
      .get(id, memberId) as GroupRow | undefined;
    return row && viewOf(row);
  }

  async groupsOf(memberId: string): Promise<GroupView[]> {
    const rows = this.database.connection
      .prepare(
        `SELECT ${GROUP_COLUMNS} FROM expense_groups g ${MEMBER_OF_GROUP} WHERE m.account_id = ? ORDER BY g.created_at DESC, g.rowid DESC`,
      )
      .all(memberId) as GroupRow[];
    return rows.map(viewOf);
  }

  async membersOf(id: string, memberId: string): Promise<MemberView[] | undefined> {
    if (!(await this.groupOf(id, memberId))) return undefined;
    const rows = this.database.connection
      .prepare(
        `SELECT m.account_id, a.name, ${JOINED_AT} AS joined_at, g.owner_id
           FROM expense_group_members m
           JOIN expense_groups g ON g.id = m.group_id
           JOIN accounts a ON a.id = m.account_id
          WHERE m.group_id = ?
          ORDER BY ${JOINED_AT}, m.rowid`,
      )
      .all(id) as { account_id: string; name: string; joined_at: string; owner_id: string }[];
    return rows.map(row => ({
      memberId: row.account_id,
      name: row.name,
      role: row.account_id === row.owner_id ? 'owner' : 'member',
      joinedAt: row.joined_at,
    }));
  }

  private insertMembers(groupId: string, members: GroupSnapshot['members']): void {
    const insert = this.database.connection.prepare(
      'INSERT OR IGNORE INTO expense_group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)',
    );
    for (const member of members) insert.run(groupId, member.accountId, member.joinedAt);
  }
}
