import type { FastifyRequest } from 'fastify';
import { type Account, accountForToken } from './accounts/accounts';
import type { Database } from './database';
import { Refusal } from './refusal';

const BEARER = /^Bearer\s+(\S+)$/i;

const UNAUTHENTICATED = 'Sign in with a token: send Authorization: Bearer <token>.';

/**
 * The account the request is signed in as, if any. A request with no `Authorization` header is
 * signed out; one whose token proves nothing is refused, whatever the route.
 */
export async function signedInAccount(db: Database, request: FastifyRequest): Promise<Account | undefined> {
  const header = request.headers.authorization;
  if (header === undefined) {
    return undefined;
  }
  const match = BEARER.exec(header);
  const account = match ? await accountForToken(db, match[1]) : undefined;
  if (!account) {
    throw new Refusal(401, 'Unauthenticated', 'The bearer token is missing, malformed or unknown.');
  }
  return account;
}

/** The account the request is signed in as. A request that is not signed in is refused with `401`. */
export async function requireAccount(db: Database, request: FastifyRequest): Promise<Account> {
  const account = await signedInAccount(db, request);
  if (!account) {
    throw new Refusal(401, 'Unauthenticated', UNAUTHENTICATED);
  }
  return account;
}
