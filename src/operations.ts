import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
import { callerOf } from './sessions';
import { Refusal } from './refusal';

/**
 * An operation is a request the application answers later: it is `PENDING` until a background job
 * ends it with `SUCCESS` (and a `result`) or `ERROR` (and an `error`). It is kept with the account
 * that made the request, or with none when that request had no token.
 */
export async function createOperation(db: Queryable, accountId: string | null): Promise<string> {
  const id = randomUUID();
  await db.run("INSERT INTO operations (id, account_id, status, created_at) VALUES (?, ?, 'PENDING', ?)", [
    id,
    accountId,
    new Date().toISOString(),
  ]);
  return id;
}

export async function succeedOperation(db: Queryable, id: string, result: unknown): Promise<void> {
  await db.run("UPDATE operations SET status = 'SUCCESS', result = ? WHERE id = ? AND status = 'PENDING'", [
    JSON.stringify(result),
    id,
  ]);
}

export async function failOperation(
  db: Queryable,
  id: string,
  error: { type: string; message: string },
): Promise<void> {
  await db.run(
    "UPDATE operations SET status = 'ERROR', error_type = ?, error_message = ? WHERE id = ? AND status = 'PENDING'",
    [error.type, error.message, id],
  );
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
export function registerOperationRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { operationId: string } }>(
    '/operations/:operationId',
    { schema: { response: { 200: operationSchema } } },
    async request => {
      const row = await db.get<OperationRow>(
        'SELECT account_id, status, result, error_type, error_message FROM operations WHERE id = ?',
        [request.params.operationId],
      );
      if (!row) throw new Refusal(404, 'NotFound', 'There is no such operation.');
      const caller = await callerOf(db, request);
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
