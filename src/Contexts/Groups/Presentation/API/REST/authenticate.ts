import { FastifyRequest } from 'fastify';

import { Clock } from '@Architecture/Application';

import { ITokenIssuer } from '@Contexts/Groups/Application/Ports/ITokenIssuer';

/**
 * Says who is calling: the account a valid bearer token names, in the role it was given at sign-in. A request with no token, or a token
 * that proves nothing, stays anonymous; the routes that need a caller refuse it with 401, the others do not ask.
 */
export function authenticateWithToken(tokens: ITokenIssuer, clock: Clock) {
  return async (request: FastifyRequest): Promise<void> => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '');
    const session = match ? tokens.verify(match[1] as string, clock()) : null;
    if (session) request.auth = { subjectId: session.accountId, role: session.role };
  };
}
