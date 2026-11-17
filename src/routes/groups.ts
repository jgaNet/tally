import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { createGroup, findGroupOfMember, groupsOfMember } from '../groups';
import { requireCaller } from '../http';
import { Refusal } from '../refusal';

interface CreateGroupBody {
  name: string;
  currency: string;
}

/** Only the shape is checked here (a missing or wrongly typed field is `400`); values are checked by the rules. */
const CREATE_GROUP_BODY = {
  type: 'object',
  required: ['name', 'currency'],
  properties: { name: { type: 'string' }, currency: { type: 'string' } },
};

const GROUP = {
  type: 'object',
  required: ['id', 'name', 'currency', 'ownerId'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    currency: { type: 'string' },
    ownerId: { type: 'string' },
  },
};

export function registerGroupRoutes(server: FastifyInstance, db: DatabaseSync): void {
  server.post<{ Body: CreateGroupBody }>(
    '/groups',
    {
      schema: {
        body: CREATE_GROUP_BODY,
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const caller = requireCaller(db, request);
      const { name, currency } = request.body;
      const id = createGroup(db, { ownerId: caller.id, name, currency });
      return reply.code(201).send({ id });
    },
  );

  server.get<{ Params: { id: string } }>('/groups/:id', { schema: { response: { 200: GROUP } } }, async request => {
    const caller = requireCaller(db, request);
    const group = findGroupOfMember(db, caller.id, request.params.id);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    return group;
  });

  server.get('/groups/mine', { schema: { response: { 200: { type: 'array', items: GROUP } } } }, async request => {
    const caller = requireCaller(db, request);
    return groupsOfMember(db, caller.id);
  });
}
