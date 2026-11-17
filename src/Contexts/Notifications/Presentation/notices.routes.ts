import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getMyNotices } from '@Contexts/Notifications/Application/Notices';

/** The notices' routes, at the API's root with their full path (docs/adr/0003). */
export const noticeRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/notices', { schema: { tags: ['notices'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyNotices), undefined),
  );
  done();
};
