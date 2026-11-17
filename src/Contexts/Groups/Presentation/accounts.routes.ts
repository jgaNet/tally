import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';

/** The bodies say their shape only (API-BODY-SHAPE): whether a value is allowed is the domain's to refuse. */
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

/** The accounts' routes, under `/v1/accounts`: each answers its use case at once, and nothing else. */
export const accountRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Body: { email: string; password: string; name: string } }>(
    '/',
    { schema: { body: signUpBody, tags: ['accounts'] } },
    (req, reply) => answerAtOnce(req, reply, module.useCase(signUp), req.body, { created: true }),
  );

  fastify.post<{ Body: { email: string; password: string } }>(
    '/login',
    { schema: { body: signInBody, tags: ['accounts'] } },
    (req, reply) => answerAtOnce(req, reply, module.useCase(signIn), req.body),
  );

  fastify.get('/me', { schema: { tags: ['accounts'] } }, (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMyAccount), undefined),
  );

  done();
};
