import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyAccountController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyAccountController';
import {
  GetMyAccountResSchema,
  LoginBodySchema,
  LoginResSchema,
  SignUpBodySchema,
  SignUpResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/account.routes.schema';

export const accountRoutes = function (
  fastify: FastifyInstance,
  { groupsModule }: { groupsModule: Module },
  done: () => void,
) {
  const controller = new FastifyAccountController({ module: groupsModule });

  fastify.post(
    '/',
    { schema: { tags: ['accounts'], body: SignUpBodySchema, response: SignUpResSchema } },
    controller.signUp.bind(controller),
  );

  fastify.post(
    '/login',
    { schema: { tags: ['accounts'], body: LoginBodySchema, response: LoginResSchema } },
    controller.login.bind(controller),
  );

  fastify.get(
    '/me',
    { schema: { tags: ['accounts'], response: GetMyAccountResSchema } },
    controller.getMyAccount.bind(controller),
  );

  done();
};
