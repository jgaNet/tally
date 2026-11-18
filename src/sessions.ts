import type { FastifyRequest } from 'fastify';
import type { Queryable } from './database';
import { hashToken, newToken } from './credentials';
import { Refusal } from './refusal';

/** Stores a new session for the account and returns its bearer token. */
export async function issueSession(db: Queryable, accountId: string): Promise<string> {
  const token = newToken();
  await db.run('INSERT INTO sessions (token_hash, account_id, created_at) VALUES (?, ?, ?)', [
    hashToken(token),
    accountId,
    new Date().toISOString(),
  ]);
  return token;
}

/**
 * The account the request is signed in as, or `null` when it carries no `Authorization` header.
 * A header that is not a bearer token of a known session proves nothing, so it is refused with `401`.
 */
export async function callerOf(db: Queryable, request: FastifyRequest): Promise<string | null> {
  const header = request.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer (\S+)$/.exec(header);
  const row = match
    ? await db.get<{ account_id: string }>('SELECT account_id FROM sessions WHERE token_hash = ?', [
        hashToken(match[1]),
      ])
    : undefined;
  if (!row) throw new Refusal(401, 'Unauthorized', 'The bearer token does not prove a signed-in account.');
  return row.account_id;
}

/** The account the request is signed in as; a request without a valid token is refused with `401`. */
export async function requireCaller(db: Queryable, request: FastifyRequest): Promise<string> {
  const accountId = await callerOf(db, request);
  if (accountId === null) throw new Refusal(401, 'Unauthorized', 'Sign in first: send the bearer token.');
  return accountId;
}
