import { IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { InvalidCredentials } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { IAccountQueries } from '@Contexts/Groups/Application/Ports/IAccountQueries';
import { IPasswordHasher } from '@Contexts/Groups/Application/Ports/IPasswordHasher';
import { ITokens } from '@Contexts/Groups/Application/Ports/ITokens';

/**
 * Signing in is not a fact of the domain: it checks the credentials and answers a token, and
 * nothing changes. An email no account has and a wrong password are the same refusal.
 */
export class LoginQueryHandler extends QueryHandler<
  IAccountQueries,
  { email: string; password: string },
  IResult<{ token: string }>
> {
  constructor(
    queries: IAccountQueries,
    private readonly hasher: IPasswordHasher,
    private readonly tokens: ITokens,
  ) {
    super(queries);
  }

  async execute(
    { email, password }: { email: string; password: string },
    _: ExecutionContext,
  ): Promise<IResult<{ token: string }>> {
    const credentials = await this.queries.findCredentials(email);
    // An unknown email costs the same check as a wrong password, so that time does not tell them apart.
    const matches = await this.hasher.verify(password, credentials?.passwordHash ?? '');
    if (!credentials || !matches) return Result.fail(new InvalidCredentials());
    return Result.ok({ token: this.tokens.issue(credentials.id) });
  }
}
