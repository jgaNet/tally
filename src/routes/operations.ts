import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { callerOf } from '../http';
import { Refusal } from '../refusal';
import { findOperation } from '../operations';

export function registerOperationRoutes(server: FastifyInstance, db: DatabaseSync): void {
  server.get<{ Params: { operationId: string } }>('/operations/:operationId', async request => {
    const caller = callerOf(db, request);
    const operation = findOperation(db, request.params.operationId);
    if (!operation) {
      throw new Refusal(404, 'OperationNotFound', 'No operation has this id.');
    }
    // An operation started with a token is read with that account's token only.
    if (operation.accountId !== null) {
      if (caller === null) {
        throw new Refusal(401, 'NotSignedIn', 'The request must carry a valid Bearer token.');
      }
      if (caller.id !== operation.accountId) {
        throw new Refusal(404, 'OperationNotFound', 'No operation has this id.');
      }
    }
    return operation.outcome;
  });
}
