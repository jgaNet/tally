import { Role } from '@SharedKernel/Domain';

import { IAccountStore } from '@Contexts/Groups/Application/IAccountStore';
import { ISessionTokens } from '@Contexts/Groups/Application/ISessionTokens';

/**
 * Who a request is from, by its bearer token (`Authorization: Bearer <token>`): the token the tokens port proves names the caller, as a
 * signed-in person, with the role the sign-in gave it (request 33: an administrator's). Any other request, or a token that proves nothing,
 * stays anonymous, and the transport refuses what needs a caller with `401`. A token whose account is deleted proves nothing either (feature
 * 35, request 35): the account is gone, so the token names nobody. It is the transport's authentication, given by the context that
 * owns accounts (Bootstrap's FastifyApplication, `authenticate`).
 */
export const authenticateWith =
  (tokens: ISessionTokens, accounts: IAccountStore) =>
  async (request: { headers: { authorization?: string }; auth: { subjectId: string; role: Role } }): Promise<void> => {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    if (!match) return;
    const accountId = tokens.accountOf(match[1]);
    if (!accountId || (await accounts.isDeleted(accountId))) return;
    request.auth = { subjectId: accountId, role: tokens.roleOf(match[1]) };
  };
