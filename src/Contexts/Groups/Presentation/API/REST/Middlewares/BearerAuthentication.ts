import { FastifyRequest } from 'fastify';

import { Role } from '@SharedKernel/Domain';

import { IAccessTokens } from '@Contexts/Groups/Application/Ports/IAccessTokens';

const BEARER = 'Bearer ';

/**
 * Says who is calling, from the bearer token the request carries (the transport's `authenticate`). A token that
 * proves an account makes its caller signed in; a request with none, or with one that proves nothing, stays
 * anonymous, and the routes that need a caller refuse it at once with 401.
 */
export function bearerAuthentication(tokens: IAccessTokens) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith(BEARER)) return;

    const subjectId = await tokens.verify(header.slice(BEARER.length).trim());
    if (subjectId) request.auth = { subjectId, role: Role.USER };
  };
}
