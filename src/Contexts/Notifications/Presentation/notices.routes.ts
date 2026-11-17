import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getMyNotices } from '@Contexts/Notifications/Application/Notices';

/** The notices' routes, under `/v1` (request 17): a signed-in person's own, the most recent first. */
export const noticeRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/notices', { schema: { tags: ['notices'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyNotices), undefined),
  );

  done();
};
