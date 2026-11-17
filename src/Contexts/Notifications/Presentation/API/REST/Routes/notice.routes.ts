import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyNoticeController } from '@Contexts/Notifications/Presentation/API/REST/Controllers/FastifyNoticeController';
import { GetMyNoticesResSchema } from '@Contexts/Notifications/Presentation/API/REST/Routes/notice.routes.schema';

/** The routes of notices (request 17). */
export const noticeRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyNoticeController({ module });
  const tags = ['notifications'];

  fastify.get(
    '/notices',
    { schema: { tags, response: GetMyNoticesResSchema } },
    controller.getMyNotices.bind(controller),
  );

  done();
};
