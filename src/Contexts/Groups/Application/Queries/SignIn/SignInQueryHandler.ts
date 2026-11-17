import { IResult, NotAllowedException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Email } from '@SharedKernel/Domain';

import { IAccountQueries } from '@Contexts/Groups/Domain/Account/Ports/IAccountQueries';
import { IPasswordHasher } from '@Contexts/Groups/Domain/Account/Ports/IPasswordHasher';
import { IAccessTokens } from '@Contexts/Groups/Application/Ports/IAccessTokens';

/**
 * Signing in: checks the credentials and answers a token. Nothing changes and nothing is recorded, so this
 * is a query (the storm's decision). A wrong password and an email no account has are refused with the same
 * answer, and cost the same work, so nobody learns which emails have accounts.
 */
export class SignInQueryHandler extends QueryHandler<
  IAccountQueries,
  { email: string; password: string },
  IResult<{ token: string }>
> {
  constructor(
    queries: IAccountQueries,
    private hasher: IPasswordHasher,
    private tokens: IAccessTokens,
  ) {
    super(queries);
  }

  async execute({ email, password }: { email: string; password: string }, _: ExecutionContext) {
    const address = Email.create(email);
    const credentials = address.isSuccess() ? await this.queries.findCredentials(address.data) : null;

    // With no account to check, the same hashing is done all the same, so the answer takes as long either way.
    const matches = credentials
      ? await this.hasher.verify(password, credentials.passwordHash)
      : await this.hasher.hash(password).then(() => false);

    if (!credentials || !matches) {
      return Result.fail(new NotAllowedException('Groups', 'Wrong email or password'));
    }
    return Result.ok({ token: this.tokens.issue(credentials.id) });
  }
}
