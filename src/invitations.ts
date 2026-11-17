import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { rawBalanceOf } from './balances';
import { Refusal } from './refusal';
import { inTransaction } from './transactions';

/** What a link to a group shows before it is accepted. `invitedBy` is the member who created it. */
export interface Invitation {
  readonly id: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly invitedBy: string;
}

interface InvitationRow {
  id: string;
  group_id: string;
  group_name: string;
  invited_by: string;
}

/**
 * Creates an invitation to `groupId`, created by `accountId` (who must be a member; checked by the
 * caller), and returns its id. The id is the link: 32 random bytes, so it cannot be guessed. It stays
 * usable, for any number of people.
 */
export function createInvitation(db: DatabaseSync, input: { groupId: string; accountId: string }): string {
  const id = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO invitations (id, group_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    input.groupId,
    input.accountId,
    new Date().toISOString(),
  );
  return id;
}

/** The invitation with this id, or `undefined`. Reading never changes it. */
export function findInvitation(db: DatabaseSync, id: string): Invitation | undefined {
  const row = db
    .prepare(
      `SELECT i.id, i.group_id, g.name AS group_name, i.created_by AS invited_by
       FROM invitations i
       JOIN groups g ON g.id = i.group_id
       WHERE i.id = ?`,
    )
    .get(id) as InvitationRow | undefined;
  return row && { id: row.id, groupId: row.group_id, groupName: row.group_name, invitedBy: row.invited_by };
}

/**
 * Makes `accountId` a member of the group the invitation `id` leads to, with the rights of a member.
 * An unknown invitation is refused with `404`; an account already in the group with `409`, and its
 * membership stays as it was. An account that left the group joins again, last in the order of the members, with a
 * balance of 0: what it had passed to the owner when it left stays with the owner.
 */
export function acceptInvitation(db: DatabaseSync, input: { id: string; accountId: string }): void {
  const { id, accountId } = input;
  inTransaction(db, () => {
    const invitation = findInvitation(db, id);
    if (!invitation) throw new Refusal(404, 'InvitationNotFound', 'No invitation has this id.');
    const alreadyMember = db
      .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NULL')
      .get(invitation.groupId, accountId);
    if (alreadyMember) throw new Refusal(409, 'AlreadyMember', 'The account is already a member of this group.');
    // An account that left is joined afresh: its earlier record goes, so it is last in the order of the members.
    const earlier = db
      .prepare('SELECT balance_base FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NOT NULL')
      .get(invitation.groupId, accountId) as { balance_base: number } | undefined;
    let base = 0;
    if (earlier !== undefined) {
      // Its balance passed to the owner when it left, and stays with the owner; the member joins at 0, so its base
      // becomes its raw balance now, and the owner takes on what the base moves by, so the balances still add up to 0.
      base = rawBalanceOf(db, invitation.groupId, accountId);
      const passedOn = base - Number(earlier.balance_base);
      db.prepare(
        'UPDATE group_members SET balance_base = balance_base - ? WHERE group_id = ? AND account_id = (SELECT owner_id FROM groups WHERE id = ?)',
      ).run(passedOn, invitation.groupId, invitation.groupId);
    }
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NOT NULL').run(
      invitation.groupId,
      accountId,
    );
    db.prepare('INSERT INTO group_members (group_id, account_id, joined_at, balance_base) VALUES (?, ?, ?, ?)').run(
      invitation.groupId,
      accountId,
      new Date().toISOString(),
      base,
    );
  });
}
