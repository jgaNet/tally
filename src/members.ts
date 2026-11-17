import type { DatabaseSync } from 'node:sqlite';

export type Role = 'owner' | 'member';

export interface Member {
  memberId: string;
  name: string;
  role: Role;
  joinedAt: string;
}

/** Makes the account a member of the group, as of now. */
export function addMember(db: DatabaseSync, groupId: string, accountId: string): void {
  db.prepare('INSERT INTO group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)').run(
    groupId,
    accountId,
    new Date().toISOString(),
  );
}

export function isMember(db: DatabaseSync, groupId: string, accountId: string): boolean {
  return (
    db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?').get(groupId, accountId) !==
    undefined
  );
}

interface MemberRow {
  member_id: string;
  name: string;
  owner_id: string;
  joined_at: string;
}

/** The members of the group, the owner first, then the others in the order they joined. */
export function listMembers(db: DatabaseSync, groupId: string): Member[] {
  const rows = db
    .prepare(
      `SELECT m.account_id AS member_id, a.name, g.owner_id, m.joined_at
       FROM group_members m
       JOIN accounts a ON a.id = m.account_id
       JOIN groups g ON g.id = m.group_id
       WHERE m.group_id = ? ORDER BY m.joined_at, m.rowid`,
    )
    .all(groupId) as unknown as MemberRow[];
  return rows.map(row => ({
    memberId: row.member_id,
    name: row.name,
    role: row.member_id === row.owner_id ? 'owner' : 'member',
    joinedAt: row.joined_at,
  }));
}
