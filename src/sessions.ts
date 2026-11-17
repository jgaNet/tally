import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { hashToken, newToken } from './credentials';
import { Refusal } from './refusal';

/** Stores a new session for the account and returns its bearer token. */
export function issueSession(db: DatabaseSync, accountId: string): string {
  const token = newToken();
  db.prepare('INSERT INTO sessions (token_hash, account_id, created_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    accountId,
    new Date().toISOString(),
  );
  return token;
}

/**
 * The account the request is signed in as, or `null` when it carries no `Authorization` header.
 * A header that is not a bearer token of a known session proves nothing, so it is refused with `401`.
 */
export function callerOf(db: DatabaseSync, request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  const row = match
    ? (db.prepare('SELECT account_id FROM sessions WHERE token_hash = ?').get(hashToken(match[1])) as
        { account_id: string } | undefined)
    : undefined;
  if (!row) throw new Refusal(401, 'Unauthorized', 'The bearer token does not prove a signed-in account.');
  return row.account_id;
}

/** The account the request is signed in as; a request without a valid token is refused with `401`. */
export function requireCaller(db: DatabaseSync, request: FastifyRequest): string {
  const accountId = callerOf(db, request);
  if (accountId === null) throw new Refusal(401, 'Unauthorized', 'Sign in first: send the bearer token.');
  return accountId;
}
