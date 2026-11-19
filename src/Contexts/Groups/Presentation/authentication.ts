import { FastifyRequest } from 'fastify';

import { Role } from '@SharedKernel/Domain';
import { IAccessTokens } from '@Contexts/Groups/Application/IAccessTokens';

/**
 * Who is calling, from `Authorization: Bearer <token>`: the account the token names, as a signed-in user. A request
 * with no token, or one that proves nothing, stays anonymous; the route refuses it with 401 where it needs a caller.
 */
export const authenticateWith =
  (tokens: IAccessTokens) =>
  async (request: FastifyRequest): Promise<void> => {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    if (!match) return;
    const caller = await tokens.accountOf(match[1]);
    if (caller) request.auth = { subjectId: caller.accountId, role: caller.administrator ? Role.ADMIN : Role.USER };
  };
