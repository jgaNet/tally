import { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';
import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';

type SignUpInput = { email: string; password: string; name: string };
type SignInInput = { email: string; password: string };

const SHAPE_REFUSAL = 'The body must have these fields, each a string';

/**
 * The shape of a body, checked on the raw request before the schema coerces it: a field missing or not a string is a
 * refusal of its shape, at once, with 400 (API-BODY-SHAPE). Whether the values are allowed is the use case's to say.
 */
const shapeOf =
  (fields: string[]) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const body: unknown = request.body;
    const ok =
      typeof body === 'object' &&
      body !== null &&
      fields.every(field => typeof (body as Record<string, unknown>)[field] === 'string');
    if (!ok) return reply.code(400).send({ message: `${SHAPE_REFUSAL}: ${fields.join(', ')}` });
    return undefined;
  };

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
