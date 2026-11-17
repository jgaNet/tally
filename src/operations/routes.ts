import type { FastifyInstance } from 'fastify';
import { signedInAccount } from '../auth';
import type { Database } from '../database';
import { Refusal } from '../refusal';
import { findOperation } from './operations';

const operationSchema = {
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['PENDING', 'SUCCESS', 'ERROR'] },
    result: {},
    error: {
      type: 'object',
      required: ['type', 'message'],
      properties: { type: { type: 'string' }, message: { type: 'string' } },
    },
  },
};

export function registerOperationRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { operationId: string } }>(
    '/operations/:operationId',
    {
      schema: {
        params: { type: 'object', required: ['operationId'], properties: { operationId: { type: 'string' } } },
        response: { 200: operationSchema },
      },
    },
    async request => {
      // A token that proves nothing is refused; so is no token for an operation that a token started.
      const caller = signedInAccount(db, request);
      const operation = findOperation(db, request.params.operationId);
      if (!operation) {
        throw new Refusal(404, 'NotFound', 'There is no such operation.');
      }
      if (operation.accountId !== null) {
        if (!caller) {
          throw new Refusal(
            401,
            'Unauthenticated',
            'This operation was started by a signed-in request: send its token.',
          );
        }
        if (caller.id !== operation.accountId) {
          throw new Refusal(404, 'NotFound', 'There is no such operation.');
        }
      }
      const answer: { status: string; result?: unknown; error?: { type: string; message: string } } = {
        status: operation.status,
      };
      if (operation.result !== undefined) {
        answer.result = operation.result;
      }
      if (operation.error !== undefined) {
        answer.error = operation.error;
      }
      return answer;
    },
  );
}
