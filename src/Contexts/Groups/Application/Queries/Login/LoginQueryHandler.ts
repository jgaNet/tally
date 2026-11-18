import { IResult, Result } from '@Architecture/Domain';
import { Clock, ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Email } from '@SharedKernel/Domain';

import { roleOf } from '@Contexts/Groups/Domain/Account/AdministratorRole';
import { InvalidCredentials } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { IPasswordHasher } from '@Contexts/Groups/Domain/Account/Ports/IPasswordHasher';
import { IAccountCredentials } from '@Contexts/Groups/Application/Ports/IAccountCredentials';
import { ITokenIssuer } from '@Contexts/Groups/Application/Ports/ITokenIssuer';

/**
 * Signing in is not a fact of the domain (the session's hot spot): the credentials are checked and a token is answered, nothing changes
 * and nothing is recorded. A wrong password and an email no account has are one refusal, and cost the same work, so nothing tells them
 * apart. The token carries the role the account has: an administrator's is decided here, from the administrators' emails the server was
 * started with (request 33), read when the sign-in is asked.
 */
export class LoginQueryHandler extends QueryHandler<
  IAccountCredentials,
  { email: string; password: string },
  IResult<string>
> {
  readonly #decoy: string;

  constructor(
    credentials: IAccountCredentials,
    private passwordHasher: IPasswordHasher,
    private tokens: ITokenIssuer,
    private clock: Clock,
    private administrators: () => readonly string[],
  ) {
    super(credentials);
    this.#decoy = passwordHasher.hash('nobody');
  }

  async execute(
    { email, password }: { email: string; password: string },
    _: ExecutionContext,
  ): Promise<IResult<string>> {
    const normalised = Email.create(email);
    const known = normalised.isSuccess() ? await this.queries.findByEmail(normalised.data.value) : null;

    const matches = this.passwordHasher.matches(password, known?.passwordHash ?? this.#decoy);
    if (!known || !matches) return Result.fail(new InvalidCredentials());

    return Result.ok(this.tokens.issue(known.accountId, roleOf(email, this.administrators()), this.clock()));
  }
}
