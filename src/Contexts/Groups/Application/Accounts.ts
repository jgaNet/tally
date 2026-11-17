import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { IAccountStore, AccountView } from '@Contexts/Groups/Application/IAccountStore';
import { IPasswordHasher } from '@Contexts/Groups/Application/IPasswordHasher';
import { ISessionTokens } from '@Contexts/Groups/Application/ISessionTokens';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import {
  AccountNotFoundException,
  InvalidCredentialsException,
} from '@Contexts/Groups/Domain/Account/AccountExceptions';

/** A sign-up as the request carries it. The password is typed here and never stored. */
export interface SignUpInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

/** A sign-in as the request carries it. */
export interface SignInInput {
  readonly email: string;
  readonly password: string;
}

/**
 * Signs someone up: the account allows it, or refuses it with the rule. Anyone may ask, since the sign-up is what makes
 * an account. The account is saved, and what it recorded (AccountRegistered, ADR 3) goes out with the commit, through
 * the outbox: nothing subscribes to it yet.
 */
export const signUp = command(
  'SignUp',
  (accounts: IAccountStore, passwords: IPasswordHasher, clock: Clock) =>
    async ({ email, password, name }: SignUpInput, context): Promise<IResult<string>> => {
      const emailTaken = await accounts.emailTaken(email);
      const passwordHash = await passwords.hash(password);
      const created = Account.create({ email, password, passwordHash, name }, { emailTaken }, clock());
      if (created.isFailure()) return created;

      await accounts.add(created.data);
      await publishDomainEvents(created.data, context);
      return Result.ok(created.data.toSnapshot().id);
    },
  { caller: 'anyone' },
);

/**
 * Signs someone in: checks the password against the account's hash and answers a token. Nothing changes and nothing is
 * recorded. A wrong password and an email no account has get the same answer, and cost the same work to refuse, so
 * nobody learns which emails have accounts.
 */
export const signIn = query(
  'SignIn',
  (accounts: IAccountStore, passwords: IPasswordHasher, tokens: ISessionTokens) =>
    async ({ email, password }: SignInInput): Promise<IResult<{ token: string }>> => {
      const credentials = await accounts.credentialsOf(email);
      if (!credentials) {
        // The same work a check costs, against no account: the answer takes as long as a wrong password's.
        await passwords.hash(password);
        return Result.fail(new InvalidCredentialsException());
      }
      if (!(await passwords.matches(password, credentials.passwordHash))) {
        return Result.fail(new InvalidCredentialsException());
      }
      return Result.ok({ token: tokens.issue(credentials.id) });
    },
  { caller: 'anyone' },
);

/** The signed-in person's own account, as the read model. Nobody else's is answered. */
export const getMyAccount = query('GetMyAccount', (accounts: IAccountStore) => async (_input: undefined, context) => {
  const view: AccountView | undefined = await accounts.view(callerOf(context));
  return view ? Result.ok(view) : Result.fail(new AccountNotFoundException());
});
