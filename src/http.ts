import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { accountForToken, type Account } from './accounts';
import { Refusal } from './refusal';

const BEARER = /^Bearer\s+(\S+)$/;

/**
 * The account the request is signed in as, or `null` when it carries no `Authorization` header.
 * A header that proves nothing is refused with `401`.
 */
export function callerOf(db: DatabaseSync, request: FastifyRequest): Account | null {
  const header = request.headers.authorization;
  if (header === undefined) return null;
  const token = BEARER.exec(header)?.[1];
  const account = token === undefined ? undefined : accountForToken(db, token);
  if (!account) throw new Refusal(401, 'NotSignedIn', 'The request must carry a valid Bearer token.');
  return account;
}

/** The account the request is signed in as; a request without a valid token is refused with `401`. */
export function requireCaller(db: DatabaseSync, request: FastifyRequest): Account {
  const account = callerOf(db, request);
  if (!account) throw new Refusal(401, 'NotSignedIn', 'The request must carry a valid Bearer token.');
  return account;
}

/**
 * Answers a refused request: the `4xx` status of a {@link Refusal}, its body `{ statusCode, error,
 * message }`. Anything that is not a `4xx` is a failure of the server.
 */
export function sendError(error: unknown, _request: FastifyRequest, reply: FastifyReply): void {
  const statusCode = refusedStatus(error);
  if (statusCode === undefined) {
    reply.code(500).send({ statusCode: 500, error: 'Internal Server Error', message: 'The server failed.' });
    return;
  }
  reply.code(statusCode).send({
    statusCode,
    error: error instanceof Refusal ? error.type : 'BadRequest',
    message: (error as Error).message,
  });
}

function refusedStatus(error: unknown): number | undefined {
  if (error instanceof Refusal) return error.statusCode;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : undefined;
}
