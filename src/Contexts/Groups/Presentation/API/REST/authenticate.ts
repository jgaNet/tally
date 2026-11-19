import { FastifyRequest } from 'fastify';
import { IAccountQueries } from '@Contexts/Groups/Application/Ports/IAccountQueries';
import { ITokens } from '@Contexts/Groups/Application/Ports/ITokens';

/**
 * Says who is calling, from the `Authorization: Bearer <token>` header, and in which role (request 33). A request with no token,
 * or with one that proves nothing, stays anonymous (a token of an account its person deleted proves nothing, request 35); the routes that need a caller refuse it.
 */
export const authenticateWith =
  (tokens: ITokens, accounts: IAccountQueries) =>
  async (request: FastifyRequest): Promise<void> => {
    const [scheme, token] = String(request.headers.authorization ?? '').split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || !token) return;
    const claims = tokens.verify(token);
    if (claims && !(await accounts.isDeleted(claims.accountId)))
      request.auth = { subjectId: claims.accountId, role: claims.role };
  };
