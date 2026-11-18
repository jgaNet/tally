import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyNoticePreferenceController } from '@Contexts/Notifications/Presentation/API/REST/Controllers/FastifyNoticePreferenceController';
import {
  GetNoticePreferencesResSchema,
  LaterNoticePreferenceResSchema,
  SetNoticePreferenceBodySchema,
} from '@Contexts/Notifications/Presentation/API/REST/Routes/notice-preference.routes.schema';

export const noticePreferenceRoutes = function (
  fastify: FastifyInstance,
  { notificationsModule }: { notificationsModule: Module },
  done: () => void,
) {
  const controller = new FastifyNoticePreferenceController({ module: notificationsModule });

  // The whole paths, registered at the API's root beside the accounts' (request 36): a person's own kinds of notice, on or off.
  // Answered 202 and read at the operation, as every command is (request 1).
  fastify.put(
    '/accounts/me/notice-preferences/:kind',
    {
      schema: {
        tags: ['accounts'],
        body: SetNoticePreferenceBodySchema,
        response: LaterNoticePreferenceResSchema,
      },
    },
    controller.setNoticePreference.bind(controller),
  );

  fastify.get(
    '/accounts/me/notice-preferences',
    { schema: { tags: ['accounts'], response: GetNoticePreferencesResSchema } },
    controller.getNoticePreferences.bind(controller),
  );

  done();
};
