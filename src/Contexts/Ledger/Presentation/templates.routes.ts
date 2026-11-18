import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  getGroupTemplates,
  removeTemplate,
  replaceTemplate,
  saveTemplate,
} from '@Contexts/Ledger/Application/SplitTemplates';
import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/**
 * The body of a template (request 25): its name, and exactly one of its two splits, `splitBetween` or `splitByShares`. Its shape only: a
 * missing name or one of the wrong type, or neither or both splits, is `400`; the name, the members and the shares are the domain's to say.
 */
type TemplateBody =
  | { readonly name: string; readonly splitBetween: string[] }
  | { readonly name: string; readonly splitByShares: { memberId: string; shares: number }[] };

/** The schema of a template body: a name, and exactly one of the two splits, each of the shape it names. */
const templateBodySchema = {
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
        properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
      },
    },
  },
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitByShares'] }],
};

/** The split a body gives, in the domain's words. The schema has let through exactly one of the two keys. */
const splitOfTemplate = (body: TemplateBody): TemplateSplit =>
  'splitBetween' in body
    ? { kind: 'equal', memberIds: body.splitBetween }
    : { kind: 'shares', shares: body.splitByShares };

/**
 * The templates' routes (request 25, the API's fragment 25): a member saves a split under a name, and lists the group's templates; the member
 * who saved a template, or the group's owner, replaces it or removes it. Each answers its use case at once. The paths are whole, mounted at the
 * root beside the expenses' (ADR 5). A save answers `201 { id }`, as a recording does.
 */
export const templateRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Params: { id: string }; Body: TemplateBody }>(
    '/groups/:id/templates',
    { schema: { body: templateBodySchema } },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(saveTemplate),
        { groupId: req.params.id, name: req.body.name, split: splitOfTemplate(req.body) },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/templates', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupTemplates), req.params.id),
  );

  fastify.put<{ Params: { id: string }; Body: TemplateBody }>(
    '/templates/:id',
    { schema: { body: templateBodySchema } },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(replaceTemplate), {
        templateId: req.params.id,
        name: req.body.name,
        split: splitOfTemplate(req.body),
      }),
  );

  fastify.delete<{ Params: { id: string } }>('/templates/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(removeTemplate), req.params.id),
  );

  done();
};
