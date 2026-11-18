import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getNetting, netDebts } from '@Contexts/Settlements/Application/Nettings';

/**
 * The nettings' routes, at the API's root with their full path (docs/adr/0003): each answers its use case at once (request 32). A body
 * says its shape only (API-BODY-SHAPE): whether the currency is one of Tally's is the domain's to refuse, as a `422`.
 */
export const nettingRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Body: { with: string; currency: string } }>(
    '/nettings',
    {
      schema: {
        tags: ['nettings'],
        body: {
          type: 'object',
          required: ['with', 'currency'],
          properties: { with: { type: 'string' }, currency: { type: 'string' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(netDebts),
        { with: req.body.with, currency: req.body.currency },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/nettings/:id', { schema: { tags: ['nettings'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getNetting), { id: req.params.id }),
  );

  done();
};
