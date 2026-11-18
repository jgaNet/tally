import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getMyAccount, signIn, signUp, SignInInput, SignUpInput } from '@Contexts/Groups/Application/Accounts';
import { deleteAccount } from '@Contexts/Groups/Application/AccountDeletions';

/**
 * The accounts' routes, under `/v1/accounts` (ADR 4 and the API's fragment 2): each answers its use case at once. Their
 * paths are whole, mounted at the root with the groups' (ADR 5: a context has one mount). The
 * body's schema says its shape only, so a missing field or one of the wrong type is `400` before any use case runs;
 * whether a value is allowed is the domain's to say.
 */
export const accountRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Body: SignUpInput }>(
    '/accounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password', 'name'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    },
    (req, reply) => answerAtOnce(req, reply, module.useCase(signUp), req.body, { created: true }),
  );

  fastify.post<{ Body: SignInInput }>(
    '/accounts/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string' },
          },
        },
      },
    },
    (req, reply) => answerAtOnce(req, reply, module.useCase(signIn), req.body),
  );

  fastify.get('/accounts/me', (req, reply) => answerAtOnce(req, reply, module.useCase(getMyAccount), undefined));

  // The signed-in person deletes their own account (feature 35, request 35): at once, refused with 409 while a group they own has another
  // member or a payment through the provider waits; a missing caller is `401` before anything runs.
  fastify.delete('/accounts/me', (req, reply) => answerAtOnce(req, reply, module.useCase(deleteAccount), undefined));

  done();
};
