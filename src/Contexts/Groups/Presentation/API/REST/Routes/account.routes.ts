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

  // Whole paths, registered at the API's root beside the groups' (the groups share the Groups context's wiring).
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

  done();
};
