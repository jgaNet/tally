import type { Queryable } from './database';

export type Role = 'owner' | 'member';

export interface Member {
  memberId: string;
  name: string;
  role: Role;
  joinedAt: string;
}

/**
 * Makes the account a member of the group, as of now, last in the order of its members. An account that
 * left the group and joins again has its membership renewed the same way.
 */
export async function addMember(db: Queryable, groupId: string, accountId: string): Promise<void> {
  await db.run(
    `INSERT INTO group_members (group_id, account_id, joined_at, joined_order)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(joined_order), 0) + 1 FROM group_members WHERE group_id = ?))
     ON CONFLICT (group_id, account_id) DO UPDATE SET
       left_at = NULL, joined_at = excluded.joined_at, joined_order = excluded.joined_order`,
    [groupId, accountId, new Date().toISOString(), groupId],
  );
}

/** Whether the account is a member of the group now. */
export async function isMember(db: Queryable, groupId: string, accountId: string): Promise<boolean> {
  const row = await db.get('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NULL', [
    groupId,
    accountId,
  ]);
  return row !== undefined;
}

/** Whether the account is a member of the group now, or was one before it left. */
export async function hasBeenMember(db: Queryable, groupId: string, accountId: string): Promise<boolean> {
  const row = await db.get('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?', [groupId, accountId]);
  return row !== undefined;
}

interface MemberRow {
  member_id: string;
  name: string;
  owner_id: string;
  joined_at: string;
}

/** The members of the group now, the owner first, then the others in the order they joined. */
export async function listMembers(db: Queryable, groupId: string): Promise<Member[]> {
  const rows = await db.all<MemberRow>(
    `SELECT m.account_id AS member_id, a.name, g.owner_id, m.joined_at
     FROM group_members m
     JOIN accounts a ON a.id = m.account_id
     JOIN groups g ON g.id = m.group_id
     WHERE m.group_id = ? AND m.left_at IS NULL ORDER BY m.joined_order`,
    [groupId],
  );
  return rows.map(row => ({
    memberId: row.member_id,
    name: row.name,
    role: row.member_id === row.owner_id ? 'owner' : 'member',
    joinedAt: row.joined_at,
  }));
}
