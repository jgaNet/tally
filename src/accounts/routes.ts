import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { createAccount, deleteAccount, login } from './accounts';

const credentialsBody = {
  type: 'object',
  required: ['email', 'password'],
  properties: { email: { type: 'string' }, password: { type: 'string' } },
};

export function registerAccountRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Body: { email: string; password: string; name: string } }>(
    '/accounts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password', 'name'],
          properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } },
        },
        response: { 201: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
      },
    },
    async (request, reply) => {
      const id = await createAccount(db, request.body);
      return reply.code(201).send({ id });
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/accounts/login',
    {
      schema: {
        body: credentialsBody,
        response: { 200: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } },
      },
    },
    async request => ({ token: await login(db, request.body) }),
  );

  app.get(
    '/accounts/me',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['id', 'email', 'name'],
            properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } },
          },
        },
      },
    },
    async request => {
      const { id, email, name } = await requireAccount(db, request);
      return { id, email, name };
    },
  );

  app.delete('/accounts/me', async (request, reply) => {
    const account = await requireAccount(db, request);
    await deleteAccount(db, account.id, new Date());
    return reply.code(204).send();
  });
}
