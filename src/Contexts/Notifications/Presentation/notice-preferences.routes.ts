import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getNoticePreferences, setNoticePreference } from '@Contexts/Notifications/Application/Preferences';

/**
 * The notice preferences' routes (request 36, the API's fragment 36): a signed-in person reads each kind of notice, on or off, for
 * themselves, and turns a kind on or off. Each answers the use case at once; a caller who is not signed in gets `401`.
 */
export const noticePreferenceRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/accounts/me/notice-preferences', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getNoticePreferences), undefined),
  );

  fastify.put<{ Params: { kind: string }; Body: { enabled: boolean } }>(
    '/accounts/me/notice-preferences/:kind',
    {
      schema: {
        body: {
          type: 'object',
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(setNoticePreference), {
        kind: req.params.kind,
        enabled: req.body.enabled,
      }),
  );

  done();
};
