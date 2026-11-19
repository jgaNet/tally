import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyNoticeController } from '@Contexts/Notifications/Presentation/API/REST/Controllers/FastifyNoticeController';
import {
  GetMyNoticesResSchema,
  GetNoticePreferencesResSchema,
  SetNoticePreferenceBodySchema,
  SetNoticePreferenceResSchema,
} from '@Contexts/Notifications/Presentation/API/REST/Routes/notice.routes.schema';

export const noticeRoutes = function (
  fastify: FastifyInstance,
  { notificationsModule }: { notificationsModule: Module },
  done: () => void,
) {
  const controller = new FastifyNoticeController({ module: notificationsModule });

  fastify.get(
    '/notices',
    { schema: { tags: ['notices'], response: GetMyNoticesResSchema } },
    controller.getMyNotices.bind(controller),
  );

  fastify.get(
    '/accounts/me/notice-preferences',
    { schema: { tags: ['notices'], response: GetNoticePreferencesResSchema } },
    controller.getNoticePreferences.bind(controller),
  );
  fastify.put(
    '/accounts/me/notice-preferences/:kind',
    { schema: { tags: ['notices'], body: SetNoticePreferenceBodySchema, response: SetNoticePreferenceResSchema } },
    controller.setNoticePreference.bind(controller),
  );

  done();
};
