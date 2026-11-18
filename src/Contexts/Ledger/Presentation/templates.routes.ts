import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  getGroupTemplates,
  removeTemplate,
  replaceTemplate,
  saveTemplate,
} from '@Contexts/Ledger/Application/SplitTemplates';
import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';

/**
 * The split a template's body gives, one of two (request 25): an equal split between members, or the shares of each. The body says
 * exactly one of them (`oneOf`: none or both is the wrong shape, `400`); whether the members and the shares are allowed is the domain's.
 */
const templateBody = {
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

/** The body's split, as the use cases take it: the transport has checked that exactly one of the two is given. */
function templateSplitOf(body: TemplateBody): TemplateSplit {
  if (body.splitBetween !== undefined) return { kind: 'equal', between: body.splitBetween };
  return { kind: 'shares', shares: (body.splitByShares ?? []).map(({ memberId, shares }) => ({ memberId, shares })) };
}

interface TemplateBody {
  name: string;
  splitBetween?: string[];
  splitByShares?: Array<{ memberId: string; shares: number }>;
}

/** The split templates' routes, at the API's root with their full path (docs/adr/0003, docs/adr/0024): each answers its use case at once. */
export const templateRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Params: { id: string }; Body: TemplateBody }>(
    '/groups/:id/templates',
    { schema: { body: templateBody, tags: ['templates'] } },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(saveTemplate),
        { groupId: req.params.id, name: req.body.name, split: templateSplitOf(req.body) },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/groups/:id/templates', { schema: { tags: ['templates'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupTemplates), { groupId: req.params.id }),
  );

  fastify.put<{ Params: { id: string }; Body: TemplateBody }>(
    '/templates/:id',
    { schema: { body: templateBody, tags: ['templates'] } },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(replaceTemplate), {
        id: req.params.id,
        name: req.body.name,
        split: templateSplitOf(req.body),
      }),
  );

  fastify.delete<{ Params: { id: string } }>('/templates/:id', { schema: { tags: ['templates'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(removeTemplate), { id: req.params.id }),
  );

  done();
};
