import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyNoticePreferenceController } from '@Contexts/Notifications/Presentation/API/REST/Controllers/FastifyNoticePreferenceController';
import {
  GetNoticePreferencesResSchema,
  NoticePreferenceParamsSchema,
  SetNoticePreferenceBody,
  SetNoticePreferenceReqBodySchema,
  SetNoticePreferenceResSchema,
} from '@Contexts/Notifications/Presentation/API/REST/Routes/notice-preference.routes.schema';

/** The routes of notice preferences (request 36). */
export const noticePreferenceRoutes = function (
  fastify: FastifyInstance,
  { module }: { module: Module },
  done: () => void,
) {
  const controller = new FastifyNoticePreferenceController({ module });
  const tags = ['notifications'];

  fastify.put<{ Params: { kind: string }; Body: SetNoticePreferenceBody }>(
    '/accounts/me/notice-preferences/:kind',
    {
      schema: {
        tags,
        params: NoticePreferenceParamsSchema,
        body: SetNoticePreferenceReqBodySchema,
        response: SetNoticePreferenceResSchema,
      },
    },
    controller.setNoticePreference.bind(controller),
  );

  fastify.get(
    '/accounts/me/notice-preferences',
    { schema: { tags, response: GetNoticePreferencesResSchema } },
    controller.getNoticePreferences.bind(controller),
  );

  done();
};
