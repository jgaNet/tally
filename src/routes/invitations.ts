import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { acceptInvitation, createInvitation, findInvitation } from '../invitations';
import { findGroupOfMember } from '../groups';
import { requireCaller } from '../http';
import { Refusal } from '../refusal';

const INVITATION = {
  type: 'object',
  required: ['id', 'groupId', 'groupName', 'invitedBy'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    groupName: { type: 'string' },
    invitedBy: { type: 'string' },
  },
};

export function registerInvitationRoutes(server: FastifyInstance, db: DatabaseSync): void {
  // Only a member creates an invitation; to anyone else the group does not exist.
  server.post<{ Params: { id: string } }>(
    '/groups/:id/invitations',
    {
      schema: {
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const caller = requireCaller(db, request);
      if (!findGroupOfMember(db, caller.id, request.params.id)) {
        throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
      }
      const id = createInvitation(db, { groupId: request.params.id, accountId: caller.id });
      return reply.code(201).send({ id });
    },
  );

  // Any signed-in person who has the link reads it, member or not.
  server.get<{ Params: { id: string } }>(
    '/invitations/:id',
    { schema: { response: { 200: INVITATION } } },
    async request => {
      requireCaller(db, request);
      const invitation = findInvitation(db, request.params.id);
      if (!invitation) throw new Refusal(404, 'InvitationNotFound', 'No invitation has this id.');
      return invitation;
    },
  );

  server.post<{ Params: { id: string } }>('/invitations/:id/accept', async (request, reply) => {
    const caller = requireCaller(db, request);
    acceptInvitation(db, { id: request.params.id, accountId: caller.id });
    return reply.code(204).send();
  });
}
