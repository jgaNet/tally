import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyAccountController } from '@Contexts/Groups/Presentation/API/REST/Controllers/FastifyAccountController';
import {
  AccountResSchema,
  DeleteAccountResSchema,
  SignInReqBodySchema,
  SignInResSchema,
  SignUpReqBodySchema,
  SignUpResSchema,
} from '@Contexts/Groups/Presentation/API/REST/Routes/account.routes.schema';
import { SignUpPayload } from '@Contexts/Groups/Application/Commands';

export const accountRoutes = function (fastify: FastifyInstance, { module }: { module: Module }, done: () => void) {
  const controller = new FastifyAccountController({ module });
  const tags = ['accounts'];

  fastify.post<{ Body: SignUpPayload }>(
    '/accounts',
    { schema: { tags, body: SignUpReqBodySchema, response: SignUpResSchema } },
    controller.signUp.bind(controller),
  );

  fastify.post<{ Body: { email: string; password: string } }>(
    '/accounts/login',
    { schema: { tags, body: SignInReqBodySchema, response: SignInResSchema } },
    controller.signIn.bind(controller),
  );

  fastify.get(
    '/accounts/me',
    { schema: { tags, response: AccountResSchema } },
    controller.getMyAccount.bind(controller),
  );

  fastify.delete(
    '/accounts/me',
    { schema: { tags, response: DeleteAccountResSchema } },
    controller.deleteMe.bind(controller),
  );

  done();
};
