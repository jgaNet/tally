import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getMyAccount, signIn, signUp, SignInInput, SignUpInput } from '@Contexts/Groups/Application/Accounts';

/**
 * The accounts' routes, under `/v1/accounts` (ADR 4 and the API's fragment 2): each answers its use case at once. The
 * body's schema says its shape only, so a missing field or one of the wrong type is `400` before any use case runs;
 * whether a value is allowed is the domain's to say.
 */
export const accountRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Body: SignUpInput }>(
    '/',
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
    '/login',
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

  fastify.get('/me', (req, reply) => answerAtOnce(req, reply, module.useCase(getMyAccount), undefined));

  done();
};
