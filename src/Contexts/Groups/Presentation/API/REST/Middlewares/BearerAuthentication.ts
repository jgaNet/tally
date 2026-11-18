import { FastifyRequest } from 'fastify';

import { Role } from '@SharedKernel/Domain';

import { Administrators } from '@Contexts/Groups/Domain/Account/Administrators';
import { IAccountQueries } from '@Contexts/Groups/Domain/Account/Ports/IAccountQueries';
import { IAccessTokens } from '@Contexts/Groups/Application/Ports/IAccessTokens';

const BEARER = 'Bearer ';

/**
 * Says who is calling, from the bearer token the request carries (the transport's `authenticate`). A token that
 * proves an account makes its caller signed in; a request with none, or with one that proves nothing, stays
 * anonymous, and the routes that need a caller refuse it at once with 401. The account whose email the server's administrators
 * name (`ADMIN_EMAILS`, asked at each request) is an administrator: its role travels with who is calling (request 33).
 */
export function bearerAuthentication(
  tokens: IAccessTokens,
  accounts: IAccountQueries,
  administrators: () => Administrators,
) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith(BEARER)) return;

    const subjectId = await tokens.verify(header.slice(BEARER.length).trim());
    if (!subjectId) return;

    const named = administrators();
    const account = named.isEmpty ? null : await accounts.findAccount(subjectId);
    request.auth = { subjectId, role: account && named.includes(account.email) ? Role.ADMIN : Role.USER };
  };
}
