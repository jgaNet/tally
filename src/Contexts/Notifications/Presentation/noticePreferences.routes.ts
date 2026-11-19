import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getNoticePreferences, setNoticePreference } from '@Contexts/Notifications/Application/NoticePreferences';

const SHAPE_REFUSAL = 'The body must have enabled (true or false)';

/**
 * The notice preferences' routes, under `/v1` (request 36): a signed-in person reads their own, each kind in order, and turns a kind on or
 * off. Whether the kind is one of the three is the domain's to say; whether `enabled` is a boolean is the transport's (API-BODY-SHAPE).
 */
export const noticePreferenceRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/accounts/me/notice-preferences', { schema: { tags: ['notice-preferences'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getNoticePreferences), undefined),
  );

  fastify.put(
    '/accounts/me/notice-preferences/:kind',
    {
      schema: { tags: ['notice-preferences'] },
      preValidation: async (request, reply) => {
        const body: unknown = request.body;
        const ok =
          typeof body === 'object' && body !== null && typeof (body as { enabled?: unknown }).enabled === 'boolean';
        if (!ok) return reply.code(400).send({ message: SHAPE_REFUSAL });
        return undefined;
      },
    },
    (req, reply) => {
      const { kind } = req.params as { kind: string };
      const { enabled } = req.body as { enabled: boolean };
      return answerAtOnce(req, reply, module.useCase(setNoticePreference), { kind, enabled });
    },
  );

  done();
};
