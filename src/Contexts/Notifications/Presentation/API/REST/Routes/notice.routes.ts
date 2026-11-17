import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyNoticeController } from '@Contexts/Notifications/Presentation/API/REST/Controllers/FastifyNoticeController';
import { GetNoticesResSchema } from '@Contexts/Notifications/Presentation/API/REST/Routes/notice.routes.schema';

export const noticeRoutes = function (
  fastify: FastifyInstance,
  { notificationsModule }: { notificationsModule: Module },
  done: () => void,
) {
  const controller = new FastifyNoticeController({ module: notificationsModule });

  // The whole path, registered at the API's root: a person's own notices, the most recent first (request 17).
  fastify.get(
    '/notices',
    { schema: { tags: ['notices'], response: GetNoticesResSchema } },
    controller.getMyNotices.bind(controller),
  );

  done();
};
