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

import { isObject } from './splitBody';

const SHAPE_REFUSAL =
  'The body must have name (a string), and exactly one split: splitBetween (a list of strings) or splitByShares (a list of { memberId, shares (a whole number) })';

/**
 * The shape of a template's body, by the raw request (request 25): a name, a string, and exactly one of the two splits a template can
 * be given, by equal members or by shares. A split by exact amounts is not one (it depends on an expense's amount). Whether the values are
 * allowed is the domain's to say.
 */
const hasTemplateShape = (body: unknown): boolean => {
  if (!isObject(body) || typeof body.name !== 'string') return false;
  const given = ['splitBetween', 'splitByShares'].filter(field => body[field] !== undefined);
  if (given.length !== 1) return false;
  const value = body[given[0]];
  if (!Array.isArray(value)) return false;
  if (given[0] === 'splitBetween') return value.every(member => typeof member === 'string');
  return value.every(line => isObject(line) && typeof line.memberId === 'string' && Number.isInteger(line.shares));
};

/** The split a template's body gives, as the domain takes it. Only called on a body `hasTemplateShape` has accepted. */
const templateSplitOf = (body: Record<string, unknown>): TemplateSplit =>
  body.splitBetween !== undefined
    ? { kind: 'equal', memberIds: body.splitBetween as string[] }
    : {
        kind: 'shares',
        shares: (body.splitByShares as { memberId: string; shares: number }[]).map(({ memberId, shares }) => ({
          memberId,
          shares,
        })),
      };

const refuseShapeOf = (reply: { code(statusCode: number): { send(body: unknown): unknown } }, body: unknown) =>
  hasTemplateShape(body) ? undefined : reply.code(400).send({ message: SHAPE_REFUSAL });

/** The split templates' routes, under `/v1` (request 25). Whether the name and the members are allowed is the domain's to say. */
export const templateRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post(
    '/groups/:id/templates',
    {
      schema: { tags: ['templates'] },
      preValidation: async (request, reply) => refuseShapeOf(reply, request.body),
    },
    (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      return answerAtOnce(
        req,
        reply,
        module.useCase(saveTemplate),
        { groupId: id, name: body.name as string, split: templateSplitOf(body) },
        { created: true },
      );
    },
  );

  fastify.get('/groups/:id/templates', { schema: { tags: ['templates'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupTemplates), { id: (req.params as { id: string }).id }),
  );

  fastify.put(
    '/templates/:id',
    {
      schema: { tags: ['templates'] },
      preValidation: async (request, reply) => refuseShapeOf(reply, request.body),
    },
    (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      return answerAtOnce(req, reply, module.useCase(replaceTemplate), {
        id,
        name: body.name as string,
        split: templateSplitOf(body),
      });
    },
  );

  fastify.delete('/templates/:id', { schema: { tags: ['templates'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(removeTemplate), { id: (req.params as { id: string }).id }),
  );

  done();
};
