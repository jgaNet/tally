import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getNoticePreferences, setNoticePreference } from '@Contexts/Notifications/Application/Preferences';

/** A preference's body (request 36): whether the kind is on. The shape only (API-BODY-SHAPE): the kind is the domain's to refuse. */
const setPreferenceBody = {
  type: 'object',
  required: ['enabled'],
  properties: { enabled: { type: 'boolean' } },
};

/** The routes of the notice preferences, at the API's root with their full path (docs/adr/0003): each answers its use case at once. */
export const noticePreferenceRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get('/accounts/me/notice-preferences', { schema: { tags: ['notice-preferences'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getNoticePreferences), undefined),
  );

  fastify.put<{ Params: { kind: string }; Body: { enabled: boolean } }>(
    '/accounts/me/notice-preferences/:kind',
    { schema: { body: setPreferenceBody, tags: ['notice-preferences'] } },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(setNoticePreference), {
        kind: req.params.kind,
        enabled: req.body.enabled,
      }),
  );

  done();
};
