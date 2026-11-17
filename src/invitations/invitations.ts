import { createHash, randomBytes } from 'node:crypto';
import { type Database, inTransaction } from '../database';
import { joinGroup, requireMembership } from '../groups/groups';
import { Refusal } from '../refusal';

export interface Invitation {
  /** The link's id: whoever has it may join. */
  id: string;
  groupId: string;
  groupName: string;
  /** The account id of the member who created it. */
  invitedBy: string;
}

interface InvitationRow {
  group_id: string;
  group_name: string;
  invited_by: string;
}

/** The id is a secret, so only its hash is kept: a stolen file does not carry working links. */
const keyOf = (invitationId: string): string => createHash('sha256').update(invitationId).digest('hex');

/**
 * Creates an invitation to `groupId`, made by `accountId`, who must be a member of it. The id is
 * 256 random bits, so it cannot be guessed; it stays usable until it is no longer needed.
 */
export function createInvitation(db: Database, groupId: string, accountId: string): string {
  requireMembership(db, groupId, accountId);
  const id = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO invitations (id_hash, group_id, invited_by, created_at) VALUES (?, ?, ?, ?)').run(
    keyOf(id),
    groupId,
    accountId,
    new Date().toISOString(),
  );
  return id;
}

/** The invitation with this id, or `undefined`. Reading it changes nothing and needs no membership. */
export function findInvitation(db: Database, invitationId: string): Invitation | undefined {
  const row = db
    .prepare(
      `SELECT groups.id AS group_id, groups.name AS group_name, invitations.invited_by
         FROM invitations
         JOIN groups ON groups.id = invitations.group_id
        WHERE invitations.id_hash = ?`,
    )
    .get(keyOf(invitationId)) as InvitationRow | undefined;
  if (!row) {
    return undefined;
  }
  return {
    id: invitationId,
    groupId: row.group_id,
    groupName: row.group_name,
    invitedBy: row.invited_by,
  };
}

/** Makes `accountId` a member of the invitation's group. Returns the group's id. */
export function acceptInvitation(db: Database, invitationId: string, accountId: string): string {
  return inTransaction(db, () => {
    const invitation = findInvitation(db, invitationId);
    if (!invitation) {
      throw new Refusal(404, 'NotFound', 'There is no such invitation.');
    }
    joinGroup(db, invitation.groupId, accountId);
    return invitation.groupId;
  });
}
