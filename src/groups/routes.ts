import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { Refusal } from '../refusal';
import {
  archiveGroup,
  createGroup,
  groupForMember,
  groupsOfMember,
  leaveGroup,
  membersOf,
  requireMembership,
} from './groups';
import { CURRENCIES } from './validation';

const memberSchema = {
  type: 'object',
  required: ['memberId', 'name', 'role', 'joinedAt'],
  properties: {
    memberId: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'member'] },
    joinedAt: { type: 'string' },
  },
};

const groupSchema = {
  type: 'object',
  required: ['id', 'name', 'currency', 'ownerId'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    currency: { type: 'string', enum: [...CURRENCIES] },
    ownerId: { type: 'string' },
    // Present only once the group is archived.
    archivedAt: { type: 'string' },
  },
};

export function registerGroupRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Body: { name: string; currency: string } }>(
    '/groups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'currency'],
          properties: { name: { type: 'string' }, currency: { type: 'string' } },
        },
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const owner = await requireAccount(db, request);
      const id = await createGroup(db, owner.id, request.body);
      return reply.code(201).send({ id });
    },
  );

  app.get(
    '/groups/mine',
    {
      schema: { response: { 200: { type: 'array', items: groupSchema } } },
    },
    async request => {
      const account = await requireAccount(db, request);
      return await groupsOfMember(db, account.id);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: groupSchema },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      // A group someone else is in does not exist, for this caller: the same answer as no group.
      const group = await groupForMember(db, request.params.id, account.id);
      if (!group) {
        throw new Refusal(404, 'NotFound', 'There is no such group.');
      }
      return group;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/members',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: memberSchema } },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      await requireMembership(db, request.params.id, account.id);
      return await membersOf(db, request.params.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/groups/:id/archive',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      await archiveGroup(db, request.params.id, account.id, new Date());
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/groups/:id/leave',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      await leaveGroup(db, request.params.id, account.id);
      return reply.code(204).send();
    },
  );
}
