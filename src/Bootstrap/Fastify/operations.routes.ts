import { FastifyPluginCallback } from 'fastify';

/**
 * `GET /operations/{operationId}`, the route the API declares for a command answered later. This
 * application answers every command at once (docs/adr/0002): no operation is ever made, so none is found,
 * whoever asks.
 */
export const operationRoutes: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.get('/operations/:operationId', (_req, reply) =>
    reply.code(404).send({ type: 'NotFound', message: 'No such operation' }),
  );
  done();
};
