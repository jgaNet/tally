import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyAdminController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyAdminController';
import {
  AccountSuspensionResSchema,
  GetAdministratorsLogResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/admin.routes.schema';

export const adminRoutes = function (
  fastify: FastifyInstance,
  { groupsModule }: { groupsModule: Module },
  done: () => void,
) {
  const controller = new FastifyAdminController({ module: groupsModule });

  fastify.get(
    '/admin/log',
    { schema: { tags: ['admin'], response: GetAdministratorsLogResSchema } },
    controller.getAdministratorsLog.bind(controller),
  );
  fastify.put(
    '/admin/accounts/:id/suspension',
    { schema: { tags: ['admin'], response: AccountSuspensionResSchema } },
    controller.suspendAccount.bind(controller),
  );
  fastify.delete(
    '/admin/accounts/:id/suspension',
    { schema: { tags: ['admin'], response: AccountSuspensionResSchema } },
    controller.reinstateAccount.bind(controller),
  );

  done();
};
