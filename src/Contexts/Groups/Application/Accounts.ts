import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Email } from '@SharedKernel/Domain';
import { decideSignIn, decideSignUp } from '@Contexts/Groups/Domain/Account/Account.decision';
import { EmailAlreadyUsedException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

import { AccountView, IAccountQueries } from './IAccountQueries';
import { IAccessTokens } from './IAccessTokens';
import { IAccountRepository } from './IAccountRepository';
import { IPasswordHasher } from './IPasswordHasher';

/** Anyone signs up: nobody has an account yet to be signed in as. Answers the new account's id. */
export const signUp = command(
  'SignUp',
  (accounts: IAccountRepository, passwords: IPasswordHasher, clock: Clock) =>
    async ({ email, password, name }: { email: string; password: string; name: string }, context) => {
      const address = Email.create(email);
      if (address.isFailure()) return address;
      const existing = await accounts.findByEmail(address.data);
      const decision = decideSignUp(
        existing,
        {
          email: address.data,
          password,
          passwordHash: await passwords.hash(password),
          name,
        },
        clock(),
      );
      if (decision.isFailure()) return decision;

      const account = decision.data.state;
      if (!(await accounts.insert(account))) return Result.fail(new EmailAlreadyUsedException());
      await publishDomainEvents(account, context);
      return Result.ok(account._id.value);
    },
  { caller: 'anyone' },
);

/**
 * Signing in changes nothing: it checks the credentials and answers a token. Anyone may ask; a wrong password and an
 * unknown email are refused the same way.
 */
export const signIn = query(
  'SignIn',
  (accounts: IAccountRepository, passwords: IPasswordHasher, tokens: IAccessTokens) =>
    async ({ email, password }: { email: string; password: string }) => {
      const address = Email.create(email);
      const account = address.isSuccess() ? await accounts.findByEmail(address.data) : undefined;
      const matches = await passwords.matches(password, account?.passwordHash);
      const decision = decideSignIn(account, { passwordMatches: matches });
      if (decision.isFailure()) return decision;
      return Result.ok({ token: await tokens.issue(decision.data.state._id.value) });
    },
  { caller: 'anyone' },
);

/** A signed-in person reads their own account, and nobody else's. */
export const getMyAccount = query('GetMyAccount', (accounts: IAccountQueries) => async (_input: void, context) => {
  const account: AccountView | undefined = await accounts.accountOf(callerOf(context));
  if (!account) return Result.fail(new NotFoundException('Groups', 'No account is signed in'));
  return Result.ok(account);
});
