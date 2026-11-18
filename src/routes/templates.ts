import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { requireCaller } from '../http';
import {
  removeTemplate,
  replaceTemplate,
  saveTemplate,
  templatesOfGroup,
  type Template,
  type TemplateSplit,
} from '../templates';

/**
 * A template's body: its name, and exactly one of its two splits. Only the shape is checked here (a missing or wrongly
 * typed field is `400`, and so is a body that names neither split or both); values are checked by the rules.
 */
interface TemplateBody {
  name: string;
  splitBetween?: string[];
  splitByShares?: { memberId: string; shares: number }[];
}

const TEMPLATE_BODY = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitByShares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'shares'],
        properties: { memberId: { type: 'string' }, shares: { type: 'number' } },
      },
    },
  },
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitByShares'] }],
};

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const TEMPLATE = {
  type: 'object',
  required: ['id', 'groupId', 'name'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    name: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitByShares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'shares'],
        properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
      },
    },
  },
};

/** The split the body names; the schema has checked that it names exactly one. */
function splitOf(body: TemplateBody): TemplateSplit {
  if (body.splitBetween) return { kind: 'equal', memberIds: body.splitBetween };
  return {
    kind: 'shares',
    parts: (body.splitByShares ?? []).map(part => ({ memberId: part.memberId, shares: part.shares })),
  };
}

/** A template as it reads: its fields and the split as it was given. */
function projection(template: Template) {
  const { split, ...fields } = template;
  if (split.kind === 'equal') return { ...fields, splitBetween: split.memberIds };
  return { ...fields, splitByShares: split.parts };
}

export function registerTemplateRoutes(server: FastifyInstance, db: Database): void {
  // Any member of the group saves a template of it; the name is unique in the group.
  server.post<{ Params: { id: string }; Body: TemplateBody }>(
    '/groups/:id/templates',
    { schema: { body: TEMPLATE_BODY, response: { 201: ID } } },
    async (request, reply) => {
      const caller = await requireCaller(db, request);
      const id = await saveTemplate(db, {
        groupId: request.params.id,
        callerId: caller.id,
        name: request.body.name,
        split: splitOf(request.body),
      });
      return reply.code(201).send({ id });
    },
  );

  // Only a member reads the group's templates, the earliest saved first; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/templates',
    { schema: { response: { 200: { type: 'array', items: TEMPLATE } } } },
    async request => {
      const caller = await requireCaller(db, request);
      return (await templatesOfGroup(db, caller.id, request.params.id)).map(projection);
    },
  );

  // Only the member who saved the template, or the group's owner, replaces it.
  server.put<{ Params: { id: string }; Body: TemplateBody }>(
    '/templates/:id',
    { schema: { body: TEMPLATE_BODY } },
    async (request, reply) => {
      const caller = await requireCaller(db, request);
      await replaceTemplate(db, {
        templateId: request.params.id,
        editorId: caller.id,
        name: request.body.name,
        split: splitOf(request.body),
      });
      return reply.code(204).send();
    },
  );

  // Only the member who saved the template, or the group's owner, removes it.
  server.delete<{ Params: { id: string } }>('/templates/:id', async (request, reply) => {
    const caller = await requireCaller(db, request);
    await removeTemplate(db, { templateId: request.params.id, editorId: caller.id });
    return reply.code(204).send();
  });
}
