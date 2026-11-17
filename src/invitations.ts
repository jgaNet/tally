import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './database';
import { newToken } from './credentials';
import { findGroupOf } from './groups';
import { resetBalanceOnRejoin } from './balances';
import { addMember, isMember } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

export interface Invitation {
  id: string;
  groupId: string;
  groupName: string;
  invitedBy: string;
}

interface InvitationRow {
  id: string;
  group_id: string;
  group_name: string;
  created_by: string;
}

/**
 * Creates an invitation to the group and returns its id, which the link carries. Only a member may
 * invite; for anyone else the group does not exist.
 */
export function createInvitation(db: DatabaseSync, accountId: string, groupId: string): string {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  // 256 random bits, URL-safe: the id is the only secret that lets someone join.
  const id = newToken();
  db.prepare('INSERT INTO invitations (id, group_id, created_by, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    groupId,
    accountId,
    new Date().toISOString(),
  );
  return id;
}

export function findInvitation(db: DatabaseSync, id: string): Invitation | undefined {
  const row = db
    .prepare(
      `SELECT i.id, i.group_id, g.name AS group_name, i.created_by
       FROM invitations i JOIN groups g ON g.id = i.group_id WHERE i.id = ?`,
    )
    .get(id) as InvitationRow | undefined;
  return row && { id: row.id, groupId: row.group_id, groupName: row.group_name, invitedBy: row.created_by };
}

/**
 * The account joins the group of the invitation. An invitation stays usable; an account already in
 * the group is refused.
 */
export function acceptInvitation(db: DatabaseSync, accountId: string, id: string): void {
  const invitation = findInvitation(db, id);
  if (!invitation) throw new Refusal(404, 'NotFound', 'There is no such invitation.');
  // The check and the join are one write transaction, so two accepts cannot both join.
  inTransaction(db, () => {
    if (isMember(db, invitation.groupId, accountId)) {
      throw new Refusal(409, 'AlreadyMember', 'The account is already a member of this group.');
    }
    addMember(db, invitation.groupId, accountId);
    // A member who joins again starts at a balance of 0, whatever they were left with when they left.
    resetBalanceOnRejoin(db, invitation.groupId, accountId);
  });
}

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const invitationSchema = {
  type: 'object',
  required: ['id', 'groupId', 'groupName', 'invitedBy'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    groupName: { type: 'string' },
    invitedBy: { type: 'string' },
  },
};

export function registerInvitationRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Params: { id: string } }>(
    '/groups/:id/invitations',
    { schema: { response: { 201: idSchema } } },
    (request, reply) => {
      const accountId = requireCaller(db, request);
      return reply.code(201).send({ id: createInvitation(db, accountId, request.params.id) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/invitations/:id',
    { schema: { response: { 200: invitationSchema } } },
    request => {
      requireCaller(db, request);
      const invitation = findInvitation(db, request.params.id);
      if (!invitation) throw new Refusal(404, 'NotFound', 'There is no such invitation.');
      return invitation;
    },
  );

  app.post<{ Params: { id: string } }>('/invitations/:id/accept', (request, reply) => {
    const accountId = requireCaller(db, request);
    acceptInvitation(db, accountId, request.params.id);
    return reply.code(204).send();
  });
}
