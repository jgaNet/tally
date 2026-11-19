import { FastifyInstance } from 'fastify';
import { Module } from '@Architecture/Application';
import { FastifyAccountController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyAccountController';
import {
  DeleteAccountResSchema,
  GetMyAccountResSchema,
  LoginBodySchema,
  LoginResSchema,
  SignUpBodySchema,
  SignUpResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/account.routes.schema';

export const accountRoutes = function (
  fastify: FastifyInstance,
  { accountsModule }: { accountsModule: Module },
  done: () => void,
) {
  const controller = new FastifyAccountController({ module: accountsModule });

  fastify.post(
    '/accounts',
    { schema: { tags: ['accounts'], body: SignUpBodySchema, response: SignUpResSchema } },
    controller.signUp.bind(controller),
  );
  fastify.post(
    '/accounts/login',
    { schema: { tags: ['accounts'], body: LoginBodySchema, response: LoginResSchema } },
    controller.login.bind(controller),
  );
  fastify.get(
    '/accounts/me',
    { schema: { tags: ['accounts'], response: GetMyAccountResSchema } },
    controller.getMyAccount.bind(controller),
  );
  fastify.delete(
    '/accounts/me',
    { schema: { tags: ['accounts'], response: DeleteAccountResSchema } },
    controller.deleteAccount.bind(controller),
  );

  done();
};
