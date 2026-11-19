import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Group, GroupSnapshot } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRepository } from '@Contexts/Groups/Application/IGroupRepository';
import { GroupView, IGroupQueries, MemberView, PassView } from '@Contexts/Groups/Domain/IGroupQueries';

import { GroupsDatabase } from './GroupsDatabase';

type GroupRow = {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  created_at: string;
  version: number;
  archived_at: string | null;
};
type MemberRow = { account_id: string; joined_at: string };

const GROUP_COLUMNS = 'g.id, g.name, g.currency, g.owner_id, g.archived_at';
const MEMBER_OF_GROUP = 'JOIN expense_group_members m ON m.group_id = g.id';
/**
 * When a member joined. A membership written with no time (by an older layout of the tables, whose only membership was the owner's)
 * joined when its group was created.
 */
const JOINED_AT = "COALESCE(NULLIF(m.joined_at, ''), g.created_at)";

const viewOf = (row: Pick<GroupRow, 'id' | 'name' | 'currency' | 'owner_id' | 'archived_at'>): GroupView => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
  ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
});

/**
 * The groups in PostgreSQL: the repository `CreateGroup` inserts into and `AcceptInvitation` loads and saves, and the read side
 * `GetGroup`, `GetMyGroups` and `GetGroupMembers` read. A group and its members are written in one transaction, so a group
 * always has its first member. A save is conditional on the version the group was read at (CONC-OPTIMISTIC, ADR 4).
 */
export class SqliteGroups implements IGroupRepository, IGroupQueries {
  constructor(private readonly database: GroupsDatabase) {}

  async insert(group: Group): Promise<void> {
    const { id, name, currency, ownerId, createdAt, members } = group.toSnapshot();
    await this.database.transaction(async () => {
      await this.database.execute(
        'INSERT INTO expense_groups (id, name, currency, owner_id, created_at, version) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, name, currency, ownerId, createdAt, group.version + 1],
      );
      await this.insertMembers(id, members);
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async get(id: string): Promise<Group | undefined> {
    const row = await this.database.row<GroupRow>(
      'SELECT id, name, currency, owner_id, created_at, version, archived_at FROM expense_groups WHERE id = $1 AND merged_into IS NULL',
      [id],
    );
    if (!row) return undefined;
    const members = await this.database.rows<MemberRow>(
      `SELECT m.account_id, ${JOINED_AT} AS joined_at
         FROM expense_group_members m JOIN expense_groups g ON g.id = m.group_id
        WHERE m.group_id = $1
        ORDER BY ${JOINED_AT}, m.seq`,
      [id],
    );
    const snapshot: GroupSnapshot = {
      id: row.id,
      name: row.name,
      currency: row.currency as GroupSnapshot['currency'],
      ownerId: row.owner_id,
      createdAt: row.created_at,
      members: members.map(member => ({ accountId: member.account_id, joinedAt: member.joined_at })),
      version: row.version,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    };
    return Group.fromSnapshot(snapshot);
  }

  async save(group: Group): Promise<void> {
    const { id, members, archivedAt, mergedInto } = group.toSnapshot();
    await this.database.transaction(async () => {
      const updated = await this.database.execute(
        'UPDATE expense_groups SET version = $1, archived_at = $2, merged_into = $3 WHERE id = $4 AND version = $5',
        [group.version + 1, archivedAt ?? null, mergedInto ?? null, id, group.version],
      );
      if (updated !== 1) {
        throw new ConcurrencyConflictException('Groups', 'The group changed since it was read');
      }
      // The members stored are kept as they are, except those who left since the read: they are removed. Those who joined
      // since the read are inserted; a member who left and joins again is inserted again, last.
      const kept = members.map(member => member.accountId);
      await this.database.execute(
        'DELETE FROM expense_group_members WHERE group_id = $1 AND NOT (account_id = ANY($2::text[]))',
        [id, kept],
      );
      await this.insertMembers(id, members);
      for (const { from, to, amount, at } of group.newPasses) {
        await this.database.execute(
          'INSERT INTO expense_group_passes (group_id, from_account, to_account, amount, passed_at) VALUES ($1, $2, $3, $4, $5)',
          [id, from, to, amount, at.toISOString()],
        );
      }
    });
  }

  /**
   * Moves the balances that passed to an owner from a group merged into the group kept (request 31): they are the kept group's from then on,
   * each with its own amount, its owner and its time. Made in the merge's transaction, with the members and the group (ADR 28).
   */
  async movePasses(fromGroupId: string, toGroupId: string): Promise<void> {
    await this.database.execute('UPDATE expense_group_passes SET group_id = $1 WHERE group_id = $2', [
      toGroupId,
      fromGroupId,
    ]);
  }

  async archivedOf(groupId: string): Promise<boolean> {
    const row = await this.database.row<{ archived_at: string | null }>(
      'SELECT archived_at FROM expense_groups WHERE id = $1',
      [groupId],
    );
    return Boolean(row?.archived_at);
  }

  async deletedOf(accountId: string): Promise<boolean> {
    const row = await this.database.row<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM accounts WHERE id = $1',
      [accountId],
    );
    return Boolean(row?.deleted_at);
  }

  async suspendedOf(accountId: string): Promise<boolean> {
    const row = await this.database.row<{ suspended_at: string | null }>(
      'SELECT suspended_at FROM accounts WHERE id = $1',
      [accountId],
    );
    return Boolean(row?.suspended_at);
  }

  async passesOf(groupId: string): Promise<PassView[]> {
    const rows = await this.database.rows<{
      seq: number;
      from_account: string;
      to_account: string;
      amount: number;
      passed_at: string;
    }>(
      'SELECT seq, from_account, to_account, amount, passed_at FROM expense_group_passes WHERE group_id = $1 ORDER BY seq',
      [groupId],
    );
    return rows.map(row => ({
      id: `pass-${row.seq}`,
      from: row.from_account,
      to: row.to_account,
      amount: row.amount,
      at: row.passed_at,
    }));
  }

  async groupOf(id: string, memberId: string): Promise<GroupView | undefined> {
    const row = await this.database.row<GroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM expense_groups g ${MEMBER_OF_GROUP} WHERE g.id = $1 AND m.account_id = $2`,
      [id, memberId],
    );
    return row && viewOf(row);
  }

  async groupsOf(memberId: string): Promise<GroupView[]> {
    const rows = await this.database.rows<GroupRow>(
      `SELECT ${GROUP_COLUMNS} FROM expense_groups g ${MEMBER_OF_GROUP} WHERE m.account_id = $1 ORDER BY g.created_at DESC, g.seq DESC`,
      [memberId],
    );
    return rows.map(viewOf);
  }

  async currentMembers(): Promise<{ groupId: string; memberIds: string[]; currency: string }[]> {
    const rows = await this.database.rows<{ group_id: string; account_id: string; currency: string }>(
      `SELECT m.group_id, m.account_id, g.currency
         FROM expense_group_members m
         JOIN expense_groups g ON g.id = m.group_id
        ORDER BY m.group_id, m.seq`,
    );
    const groups = new Map<string, { currency: string; memberIds: string[] }>();
    for (const { group_id, account_id, currency } of rows) {
      const group = groups.get(group_id) ?? { currency, memberIds: [] };
      group.memberIds.push(account_id);
      groups.set(group_id, group);
    }
    return [...groups].map(([groupId, { currency, memberIds }]) => ({ groupId, memberIds, currency }));
  }

  async membersOf(id: string, memberId: string): Promise<MemberView[] | undefined> {
    if (!(await this.groupOf(id, memberId))) return undefined;
    const rows = await this.database.rows<{ account_id: string; name: string; joined_at: string; owner_id: string }>(
      `SELECT m.account_id, a.name, ${JOINED_AT} AS joined_at, g.owner_id
         FROM expense_group_members m
         JOIN expense_groups g ON g.id = m.group_id
         JOIN accounts a ON a.id = m.account_id
        WHERE m.group_id = $1
        ORDER BY ${JOINED_AT}, m.seq`,
      [id],
    );
    return rows.map(row => ({
      memberId: row.account_id,
      name: row.name,
      role: row.account_id === row.owner_id ? 'owner' : 'member',
      joinedAt: row.joined_at,
    }));
  }

  private async insertMembers(groupId: string, members: GroupSnapshot['members']): Promise<void> {
    for (const member of members) {
      await this.database.execute(
        'INSERT INTO expense_group_members (group_id, account_id, joined_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [groupId, member.accountId, member.joinedAt],
      );
    }
  }
}
