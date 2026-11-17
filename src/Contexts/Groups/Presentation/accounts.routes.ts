import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';

import { shapeOf } from './bodyShape';

type SignUpInput = { email: string; password: string; name: string };
type SignInInput = { email: string; password: string };

const signUpBody = {
  type: 'object',
  required: ['email', 'password', 'name'],
  properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } },
};

const signInBody = {
  type: 'object',
  required: ['email', 'password'],
  properties: { email: { type: 'string' }, password: { type: 'string' } },
};

/** The accounts' routes, under `/v1` (every route is under the API's prefix). */
export const accountRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post(
    '/accounts',
    {
      schema: { tags: ['accounts'], body: signUpBody },
      preValidation: shapeOf(['email', 'password', 'name']),
    },
    (req, reply) => answerAtOnce(req, reply, module.useCase(signUp), req.body as SignUpInput, { created: true }),
  );

  fastify.post(
    '/accounts/login',
    {
      schema: { tags: ['accounts'], body: signInBody },
      preValidation: shapeOf(['email', 'password']),
    },
    (req, reply) => answerAtOnce(req, reply, module.useCase(signIn), req.body as SignInInput),
  );

  fastify.get('/accounts/me', { schema: { tags: ['accounts'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyAccount), undefined),
  );

  done();
};
