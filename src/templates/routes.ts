import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import {
  type SplitTemplate,
  type TemplateInput,
  type TemplateSplit,
  createTemplate,
  removeTemplate,
  replaceTemplate,
  templatesOfGroup,
} from './templates';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const splitBetween = { type: 'array', items: { type: 'string' } };
const splitByShares = {
  type: 'array',
  items: {
    type: 'object',
    required: ['memberId', 'shares'],
    properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
  },
};

const templateSchema = {
  type: 'object',
  required: ['id', 'groupId', 'name'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    name: { type: 'string' },
    splitBetween,
    splitByShares,
  },
};

/**
 * The body of a template: a name, and exactly one of the two splits a template may keep, else the body is of the wrong
 * shape. A split by exact amounts is none of them.
 */
const templateBodySchema = {
  type: 'object',
  required: ['name'],
  properties: { name: { type: 'string' }, splitBetween, splitByShares },
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitByShares'] }],
  not: { required: ['splitExactly'] },
};

interface Body {
  name: string;
  splitBetween?: string[];
  splitByShares?: { memberId: string; shares: number }[];
}

function inputOf(body: Body): TemplateInput {
  const split: TemplateSplit =
    body.splitByShares !== undefined
      ? { kind: 'shares', splitByShares: body.splitByShares }
      : { kind: 'equal', splitBetween: body.splitBetween ?? [] };
  return { name: body.name, split };
}

/** A template as the API reads it: its fields, and the split as it was given. */
function read({ split, ...fields }: SplitTemplate) {
  return split.kind === 'equal'
    ? { ...fields, splitBetween: split.splitBetween }
    : { ...fields, splitByShares: split.splitByShares };
}

export function registerTemplateRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string }; Body: Body }>(
    '/groups/:id/templates',
    {
      schema: {
        params: idParams,
        body: templateBodySchema,
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const account = await requireAccount(db, request);
      const id = await createTemplate(db, request.params.id, account.id, inputOf(request.body));
      return reply.code(201).send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/templates',
    { schema: { params: idParams, response: { 200: { type: 'array', items: templateSchema } } } },
    async request => {
      const account = await requireAccount(db, request);
      // Only the members of a group see its templates; anyone else is told it does not exist.
      await requireMembership(db, request.params.id, account.id);
      return (await templatesOfGroup(db, request.params.id)).map(read);
    },
  );

  app.put<{ Params: { id: string }; Body: Body }>(
    '/templates/:id',
    { schema: { params: idParams, body: templateBodySchema } },
    async (request, reply) => {
      await replaceTemplate(db, request.params.id, (await requireAccount(db, request)).id, inputOf(request.body));
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>('/templates/:id', { schema: { params: idParams } }, async (request, reply) => {
    await removeTemplate(db, request.params.id, (await requireAccount(db, request)).id);
    return reply.code(204).send();
  });
}
