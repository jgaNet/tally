import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { callerOf } from './sessions';
import { Refusal } from './refusal';

/**
 * An operation is a request the application answers later: it is `PENDING` until a background job
 * ends it with `SUCCESS` (and a `result`) or `ERROR` (and an `error`). It is kept with the account
 * that made the request, or with none when that request had no token.
 */
export function createOperation(db: DatabaseSync, accountId: string | null): string {
  const id = randomUUID();
  db.prepare("INSERT INTO operations (id, account_id, status, created_at) VALUES (?, ?, 'PENDING', ?)").run(
    id,
    accountId,
    new Date().toISOString(),
  );
  return id;
}

export function succeedOperation(db: DatabaseSync, id: string, result: unknown): void {
  db.prepare("UPDATE operations SET status = 'SUCCESS', result = ? WHERE id = ? AND status = 'PENDING'").run(
    JSON.stringify(result),
    id,
  );
}

export function failOperation(db: DatabaseSync, id: string, error: { type: string; message: string }): void {
  db.prepare(
    "UPDATE operations SET status = 'ERROR', error_type = ?, error_message = ? WHERE id = ? AND status = 'PENDING'",
  ).run(error.type, error.message, id);
}

interface OperationRow {
  account_id: string | null;
  status: 'PENDING' | 'SUCCESS' | 'ERROR';
  result: string | null;
  error_type: string | null;
  error_message: string | null;
}

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

/**
 * Only the account that made the request reads its operation. Without a token, an operation made
 * with one is `401`; with another caller's token, it is `404`.
 */
export function registerOperationRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get<{ Params: { operationId: string } }>(
    '/operations/:operationId',
    { schema: { response: { 200: operationSchema } } },
    request => {
      const row = db
        .prepare('SELECT account_id, status, result, error_type, error_message FROM operations WHERE id = ?')
        .get(request.params.operationId) as OperationRow | undefined;
      if (!row) throw new Refusal(404, 'NotFound', 'There is no such operation.');
      const caller = callerOf(db, request);
      if (row.account_id !== caller) {
        if (row.account_id !== null && caller === null) {
          throw new Refusal(401, 'Unauthorized', 'Send the bearer token of the account that made the request.');
        }
        throw new Refusal(404, 'NotFound', 'There is no such operation.');
      }
      if (row.status === 'SUCCESS') return { status: row.status, result: JSON.parse(row.result as string) };
      if (row.status === 'ERROR') {
        return {
          status: row.status,
          error: { type: row.error_type as string, message: row.error_message as string },
        };
      }
      return { status: row.status };
    },
  );
}
