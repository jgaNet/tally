import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getAdministratorsLog } from '@Contexts/Groups/Application/Administration';

/** The administrators' log, at the API's root with its full path (docs/adr/0003): it answers its use case at once, and nothing else. */
export const administrationRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/admin/log', { schema: { tags: ['administration'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getAdministratorsLog), undefined),
  );

  done();
};
