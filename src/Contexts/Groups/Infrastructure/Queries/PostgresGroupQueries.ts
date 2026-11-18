import { AuditEntry } from '@Contexts/Groups/Domain/Group/AuditEntry';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import {
  BalancePassingView,
  GroupMembership,
  GroupView,
  IGroupQueries,
  MemberView,
} from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/Repositories/PostgresGroupRepository';
import { createAccountsTable } from '@Contexts/Groups/Infrastructure/Repositories/PostgresAccountRepository';

interface GroupViewRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  archived_at: string | null;
}

interface MemberViewRow {
  account_id: string;
  name: string;
  joined_at: string;
  owner_id: string;
}

const SELECT_GROUPS = `
  SELECT g.id, g.name, g.currency, g.owner_id, g.archived_at FROM groups g
  JOIN group_members m ON m.group_id = g.id`;

/**
 * The read side of groups over the same database. Membership is part of every statement: a group is read only through
 * a row that names the caller as a current member, so nothing is filtered after the read, and a former member finds
 * no group. Reads outside a transaction see what is committed (ADR 4); a query made inside a transaction sees its own
 * writes.
 */
export class PostgresGroupQueries implements IGroupQueries {
  constructor(private database: PostgresDatabase) {
    createGroupsTables(database);
    createAccountsTable(database);
  }

  async findGroupOf(memberId: string, groupId: string): Promise<GroupView | null> {
    const row = await this.database.get<GroupViewRow>(`${SELECT_GROUPS} WHERE g.id = ? AND m.account_id = ?`, [
      groupId,
      memberId,
    ]);
    return row ? toView(row) : null;
  }

  async listGroupsOf(memberId: string): Promise<GroupView[]> {
    const rows = await this.database.all<GroupViewRow>(
      `${SELECT_GROUPS} WHERE m.account_id = ? ORDER BY g.created_at COLLATE "C" DESC, g.seq DESC`,
      [memberId],
    );
    return rows.map(toView);
  }

  async listMembersOf(memberId: string, groupId: string): Promise<MemberView[] | null> {
    const isMember = await this.database.get('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?', [
      groupId,
      memberId,
    ]);
    if (!isMember) return null;

    const rows = await this.database.all<MemberViewRow>(
      `SELECT m.account_id, a.name, m.joined_at, g.owner_id FROM group_members m
       JOIN groups g ON g.id = m.group_id
       JOIN accounts a ON a.id = m.account_id
       WHERE m.group_id = ? ORDER BY m.position`,
      [groupId],
    );
    return rows.map(row => ({
      memberId: row.account_id,
      name: row.name,
      role: row.account_id === row.owner_id ? 'owner' : 'member',
      joinedAt: row.joined_at,
    }));
  }

  async isArchived(groupId: string): Promise<boolean> {
    const row = await this.database.get<{ archived_at: string | null }>('SELECT archived_at FROM groups WHERE id = ?', [
      groupId,
    ]);
    return row?.archived_at != null;
  }

  async isSuspended(accountId: string): Promise<boolean> {
    const row = await this.database.get<{ suspended_at: string | null }>(
      'SELECT suspended_at FROM accounts WHERE id = ?',
      [accountId],
    );
    return row?.suspended_at != null;
  }

  async isDeleted(accountId: string): Promise<boolean> {
    const row = await this.database.get<{ deleted_at: string | null }>('SELECT deleted_at FROM accounts WHERE id = ?', [
      accountId,
    ]);
    return row?.deleted_at != null;
  }

  async membersOfEveryGroup(): Promise<GroupMembership[]> {
    const rows = await this.database.all<{ group_id: string; account_id: string }>(
      'SELECT group_id, account_id FROM group_members ORDER BY group_id COLLATE "C", position',
    );
    return rows.map(row => ({ groupId: row.group_id, memberId: row.account_id }));
  }

  async auditOf(groupId: string): Promise<AuditEntry[]> {
    const rows = await this.database.all<{
      id: string;
      group_id: string;
      at: string;
      by_account: string;
      action: AuditEntry['action'];
      subject_id: string;
      amount: number;
    }>('SELECT * FROM group_audit WHERE group_id = ? ORDER BY seq', [groupId]);
    return rows.map(row => ({
      id: row.id,
      groupId: row.group_id,
      at: row.at,
      by: row.by_account,
      action: row.action,
      subjectId: row.subject_id,
      amount: row.amount,
    }));
  }

  async passingsOf(groupId: string): Promise<BalancePassingView[]> {
    const rows = await this.database.all<{ from_account: string; to_account: string; amount: number }>(
      'SELECT from_account, to_account, amount FROM balance_passings WHERE group_id = ? ORDER BY seq',
      [groupId],
    );
    return rows.map(row => ({ from: row.from_account, to: row.to_account, amount: row.amount }));
  }

  async hasBeenMemberOf(askedBy: string, groupId: string, accountId: string): Promise<boolean | null> {
    const isMember = await this.database.get('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?', [
      groupId,
      askedBy,
    ]);
    if (!isMember) return null;

    const has = await this.database.get(
      `SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?
       UNION ALL
       SELECT 1 FROM former_members WHERE group_id = ? AND account_id = ?`,
      [groupId, accountId, groupId, accountId],
    );
    return has !== undefined;
  }
}

/** A group as a member reads it: its archive time is there only once it is archived, so an open group has none (request 27). */
function toView(row: GroupViewRow): GroupView {
  const view: GroupView = { id: row.id, name: row.name, currency: row.currency, ownerId: row.owner_id };
  if (row.archived_at != null) view.archivedAt = row.archived_at;
  return view;
}
