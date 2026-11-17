import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { Refusal } from '../refusal';
import { createGroup, groupForMember, groupsOfMember } from './groups';
import { CURRENCIES } from './validation';

const groupSchema = {
  type: 'object',
  required: ['id', 'name', 'currency', 'ownerId'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    currency: { type: 'string', enum: [...CURRENCIES] },
    ownerId: { type: 'string' },
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
      const owner = requireAccount(db, request);
      const id = createGroup(db, owner.id, request.body);
      return reply.code(201).send({ id });
    },
  );

  app.get(
    '/groups/mine',
    {
      schema: { response: { 200: { type: 'array', items: groupSchema } } },
    },
    async request => {
      const account = requireAccount(db, request);
      return groupsOfMember(db, account.id);
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
      const account = requireAccount(db, request);
      // A group someone else is in does not exist, for this caller: the same answer as no group.
      const group = groupForMember(db, request.params.id, account.id);
      if (!group) {
        throw new Refusal(404, 'NotFound', 'There is no such group.');
      }
      return group;
    },
  );
}
