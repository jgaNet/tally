import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { archiveGroup, createGroup, findGroupOfMember, groupsOfMember, leaveGroup, membersOfGroup } from '../groups';
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
    // Only an archived group has it: when it was archived.
    archivedAt: { type: 'string' },
  },
};

/** A member as the members of its group see it. `joinedAt` is an ISO 8601 instant. */
export const MEMBER = {
  type: 'object',
  required: ['memberId', 'name', 'role', 'joinedAt'],
  properties: {
    memberId: { type: 'string' },
    name: { type: 'string' },
    role: { enum: ['owner', 'member'] },
    joinedAt: { type: 'string' },
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

  // Only a current member leaves; the group's owner cannot. A member who left sees no group any more.
  server.post<{ Params: { id: string } }>('/groups/:id/leave', async (request, reply) => {
    const caller = requireCaller(db, request);
    leaveGroup(db, { groupId: request.params.id, accountId: caller.id });
    return reply.code(204).send();
  });

  // Only the owner archives the group, once every balance is 0 and no provider settlement is in progress; after that the
  // group is read only.
  server.post<{ Params: { id: string } }>('/groups/:id/archive', async (request, reply) => {
    const caller = requireCaller(db, request);
    archiveGroup(db, { groupId: request.params.id, accountId: caller.id });
    return reply.code(204).send();
  });

  // Only a member sees the members; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/members',
    { schema: { response: { 200: { type: 'array', items: MEMBER } } } },
    async request => {
      const caller = requireCaller(db, request);
      if (!findGroupOfMember(db, caller.id, request.params.id)) {
        throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
      }
      return membersOfGroup(db, request.params.id);
    },
  );
}
