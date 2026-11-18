import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IGroupQueries } from '@Contexts/Groups/Application/Ports/IGroupQueries';
import { IGroupMembersQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembersQueries';
import { GroupReadModel } from '@Contexts/Groups/Application/ReadModel/GroupReadModel';
import { MemberReadModel } from '@Contexts/Groups/Application/ReadModel/MemberReadModel';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

interface Row {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  archived_at: string | null;
}

interface MemberRow {
  member_id: string;
  name: string;
  owner_id: string;
  joined_at: string;
}

/** The groups' read models: what is read outside any command's transaction, so it waits for the one in progress. */
export class SqliteGroupReadModels implements IGroupQueries, IGroupMembersQueries {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
  }

  /** A group is read through its current members only: the join is what hides it from anyone who is not one. */
  async findForMember(groupId: string, accountId: string): Promise<GroupReadModel | null> {
    const row = await this.database.exclusive(() =>
      this.database.get<Row>(
        `${SELECT} JOIN group_members m ON m.group_id = g.id
         WHERE g.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
        groupId,
        accountId,
      ),
    );
    return row ? toReadModel(row) : null;
  }

  async listForMember(accountId: string): Promise<GroupReadModel[]> {
    const rows = await this.database.exclusive(() =>
      this.database.all<Row>(
        `${SELECT} JOIN group_members m ON m.group_id = g.id
         WHERE m.account_id = ? AND m.left_at IS NULL ORDER BY g.created_at DESC, g.rowid DESC`,
        accountId,
      ),
    );
    return rows.map(toReadModel);
  }

  /**
   * The members of any group, in join order, for another context that splits with them (ADR 3). It is read without the
   * database lock: it is asked inside the command deciding the split, whose transaction holds that lock, and `exclusive`
   * would wait for the transaction to end.
   */
  async memberIdsOf(groupId: string): Promise<string[]> {
    return this.database
      .all<{ account_id: string }>(
        'SELECT account_id FROM group_members WHERE group_id = ? AND left_at IS NULL ORDER BY position',
        groupId,
      )
      .map(row => row.account_id);
  }

  /** Every group's current members, in join order, read by a query outside any transaction so it waits for one in progress. */
  async membersOfEveryGroup(): Promise<{ groupId: string; memberIds: string[] }[]> {
    return this.database.exclusive(() => {
      const members = new Map<string, string[]>();
      for (const row of this.database.all<{ group_id: string; account_id: string }>(
        'SELECT group_id, account_id FROM group_members WHERE left_at IS NULL ORDER BY group_id, position',
      )) {
        members.set(row.group_id, [...(members.get(row.group_id) ?? []), row.account_id]);
      }
      return [...members].map(([groupId, memberIds]) => ({ groupId, memberIds }));
    });
  }

  /**
   * The balances passed to the owner in the group, in the order they passed (request 20). Read without the database lock, as
   * `memberIdsOf` is: Ledger asks inside the transaction of the command that decides on a balance, and `exclusive` would wait for it.
   */
  async passagesOf(groupId: string): Promise<{ from: string; to: string; amount: number }[]> {
    return this.database
      .all<{ from_account_id: string; to_account_id: string; amount: number }>(
        'SELECT from_account_id, to_account_id, amount FROM balance_passages WHERE group_id = ? ORDER BY position',
        groupId,
      )
      .map(row => ({ from: row.from_account_id, to: row.to_account_id, amount: row.amount }));
  }

  /** Whether the account is a member now: asked by a query, outside any transaction, so it waits for one in progress. */
  async isMemberOf(groupId: string, accountId: string): Promise<boolean> {
    return this.database.exclusive(
      () =>
        this.database.get<{ found: number }>(
          'SELECT 1 AS found FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NULL',
          groupId,
          accountId,
        ) !== undefined,
    );
  }

  /** Whether the account has been a member, now or before it left (ADR 4): a former member's statement is still read. */
  async hasBeenMemberOf(groupId: string, accountId: string): Promise<boolean> {
    return this.database.exclusive(
      () =>
        this.database.get<{ found: number }>(
          'SELECT 1 AS found FROM group_members WHERE group_id = ? AND account_id = ?',
          groupId,
          accountId,
        ) !== undefined,
    );
  }

  /**
   * Whether the group is archived (request 27): read inside the command deciding a change, so it takes no lock (as `memberIdsOf` does).
   * A group that is not there is not archived: the command that asks answers its own refusal for it.
   */
  async isArchivedOf(groupId: string): Promise<boolean> {
    const row = this.database.get<{ archived_at: string | null }>(
      'SELECT archived_at FROM groups WHERE id = ?',
      groupId,
    );
    return row?.archived_at != null;
  }

  /** The group's currency, read inside the command pricing a payment, so it takes no lock (as `memberIdsOf` does). */
  async currencyOf(groupId: string): Promise<string | null> {
    return (
      this.database.get<{ currency: string }>('SELECT currency FROM groups WHERE id = ?', groupId)?.currency ?? null
    );
  }

  /** The role of a member, read inside the command deciding on it, so it takes no lock (as `memberIdsOf` does). */
  async roleOf(groupId: string, accountId: string): Promise<'owner' | 'member' | null> {
    const row = this.database.get<{ owner_id: string }>(
      `SELECT g.owner_id AS owner_id FROM group_members m JOIN groups g ON g.id = m.group_id
       WHERE m.group_id = ? AND m.account_id = ? AND m.left_at IS NULL`,
      groupId,
      accountId,
    );
    if (!row) return null;
    return row.owner_id === accountId ? 'owner' : 'member';
  }

  /** The members are listed only to one of them: the same answer as a group that is not there, for anyone else. */
  async listMembers(groupId: string, accountId: string): Promise<MemberReadModel[] | null> {
    return this.database.exclusive(() => {
      const isMember = this.database.get<{ found: number }>(
        'SELECT 1 AS found FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NULL',
        groupId,
        accountId,
      );
      if (!isMember) return null;
      const rows = this.database.all<MemberRow>(
        `SELECT m.account_id AS member_id, a.name AS name, g.owner_id AS owner_id, m.joined_at AS joined_at
         FROM group_members m
         JOIN accounts a ON a.id = m.account_id
         JOIN groups g ON g.id = m.group_id
         WHERE m.group_id = ? AND m.left_at IS NULL ORDER BY m.position`,
        groupId,
      );
      return rows.map((row): MemberReadModel => ({
        memberId: row.member_id,
        name: row.name,
        role: row.member_id === row.owner_id ? 'owner' : 'member',
        joinedAt: row.joined_at,
      }));
    });
  }
}

const SELECT =
  'SELECT g.id AS id, g.name AS name, g.currency AS currency, g.owner_id AS owner_id, g.archived_at AS archived_at FROM groups g';

const toReadModel = (row: Row): GroupReadModel => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
  // Present only once the group is archived: an open group has no `archivedAt` (request 27).
  ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
});
