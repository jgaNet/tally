import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { Refusal } from '../refusal';
import { acceptInvitation, createInvitation, findInvitation } from './invitations';

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

export function registerInvitationRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string } }>(
    '/groups/:id/invitations',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      const id = await createInvitation(db, request.params.id, account.id);
      return reply.code(201).send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/invitations/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: invitationSchema },
      },
    },
    async request => {
      await requireAccount(db, request);
      const invitation = await findInvitation(db, request.params.id);
      if (!invitation) {
        throw new Refusal(404, 'NotFound', 'There is no such invitation.');
      }
      return invitation;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/invitations/:id/accept',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 201: { type: 'object', required: ['groupId'], properties: { groupId: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      const groupId = await acceptInvitation(db, request.params.id, account.id);
      return reply.code(201).send({ groupId });
    },
  );
}
