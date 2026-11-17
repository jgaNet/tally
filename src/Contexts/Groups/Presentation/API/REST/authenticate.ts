import { FastifyRequest } from 'fastify';
import { Role } from '@SharedKernel/Domain';
import { ITokens } from '@Contexts/Groups/Application/Ports/ITokens';

/**
 * Says who is calling, from the `Authorization: Bearer <token>` header. A request with no token,
 * or with one that proves nothing, stays anonymous; the routes that need a caller refuse it.
 */
export const authenticateWith =
  (tokens: ITokens) =>
  async (request: FastifyRequest): Promise<void> => {
    const [scheme, token] = String(request.headers.authorization ?? '').split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer' || !token) return;
    const accountId = tokens.verify(token);
    if (accountId) request.auth = { subjectId: accountId, role: Role.USER };
  };
