import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { logIn, signUp } from '../accounts';
import { requireCaller } from '../http';

interface SignUpBody {
  email: string;
  password: string;
  name: string;
}

interface LogInBody {
  email: string;
  password: string;
}

/** Only the shape is checked here (a missing or wrongly typed field is `400`); values are checked by the rules. */
const SIGN_UP_BODY = {
  type: 'object',
  required: ['email', 'password', 'name'],
  properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } },
};

const LOG_IN_BODY = {
  type: 'object',
  required: ['email', 'password'],
  properties: { email: { type: 'string' }, password: { type: 'string' } },
};

export function registerAccountRoutes(server: FastifyInstance, db: Database): void {
  server.post<{ Body: SignUpBody }>(
    '/accounts',
    {
      schema: {
        body: SIGN_UP_BODY,
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const id = await signUp(db, request.body);
      return reply.code(201).send({ id });
    },
  );

  server.post<{ Body: LogInBody }>(
    '/accounts/login',
    {
      schema: {
        body: LOG_IN_BODY,
        response: { 200: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } },
      },
    },
    async request => ({ token: await logIn(db, request.body) }),
  );

  server.get('/accounts/me', async request => {
    const { id, email, name } = await requireCaller(db, request);
    return { id, email, name };
  });
}
