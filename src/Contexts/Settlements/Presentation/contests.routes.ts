import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { contestSettlement, decideContest, getContests } from '@Contexts/Settlements/Application/Contests';

/** The body of an administrator's decision: whether the money arrived; its shape only, whether it is allowed is the domain's (request 33). */
type DecideContestBody = { readonly paid: boolean };

/**
 * The contests' routes (request 33, the API's fragment 33): a paid settlement through the provider contested by its payee, the contested
 * settlements read by an administrator, and an administrator's decision on one. Each answers its use case at once. A body whose shape is wrong
 * is `400` before the use case runs. The administrators' reads are never answered to anyone else, who gets the `404` they do not exist with,
 * and a decision by anyone who is not an administrator is the `403`.
 */
export const contestRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Params: { id: string } }>('/settlements/:id/contest', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(contestSettlement), req.params.id),
  );

  fastify.get('/admin/contests', (req, reply) => answerAtOnce(req, reply, module.useCase(getContests), undefined));

  fastify.post<{ Params: { id: string }; Body: DecideContestBody }>(
    '/admin/settlements/:id/decision',
    {
      schema: {
        body: {
          type: 'object',
          required: ['paid'],
          properties: { paid: { type: 'boolean' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(decideContest), { settlementId: req.params.id, paid: req.body.paid }),
  );

  done();
};
