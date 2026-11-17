import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyNoticeController } from '@Contexts/Notifications/Presentation/API/REST/Controllers/FastifyNoticeController';
import { GetMyNoticesResSchema } from '@Contexts/Notifications/Presentation/API/REST/Routes/notice.routes.schema';

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

  done();
};
