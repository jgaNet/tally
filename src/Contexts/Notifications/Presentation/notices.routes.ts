import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getMyNotices } from '@Contexts/Notifications/Application/Notices';

/**
 * The notices' route (request 17, the API's fragment 17): a signed-in person lists their own notices, the most recent first. It
 * answers the use case at once; a caller who is not signed in gets `401`.
 */
export const noticeRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/notices', (req, reply) => answerAtOnce(req, reply, module.useCase(getMyNotices), undefined));

  done();
};
