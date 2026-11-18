import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { publishDomainEvents } from '@Architecture/Application';
import { NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain/Email';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IAccountQueries } from '@Contexts/Groups/Domain/Account/Ports/IAccountQueries';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { EmailAlreadyUsedException } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { Password } from '@Contexts/Groups/Domain/Account/Password';
import { IPasswordHasher } from '@Contexts/Groups/Application/Ports/IPasswordHasher';
import { ISessionTokens } from '@Contexts/Groups/Application/Ports/ISessionTokens';

/** The one refusal of sign-in: the same for an email no account has and for a wrong password (the storm). */
const WRONG_CREDENTIALS = 'The email or the password is wrong';

/** Signs up: anyone may ask, and the account's id is the answer. */
export const signUp = command(
  'SignUp',
  (accounts: IAccountRepository, passwords: IPasswordHasher) =>
    async ({ email, password, name }: { email: string; password: string; name: string }, context) => {
      const address = Email.create(email);
      if (address.isFailure()) return address;
      const displayName = AccountName.create(name);
      if (displayName.isFailure()) return displayName;
      const secret = Password.create(password);
      if (secret.isFailure()) return secret;

      if (await accounts.findByEmail(address.data.value)) {
        return Result.fail(new EmailAlreadyUsedException());
      }
      const account = Account.create({
        email: address.data,
        name: displayName.data,
        passwordHash: await passwords.hash(secret.data.value),
      });

      const saved = await accounts.save(account);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(account, context);
      return Result.ok(account.id);
    },
  { caller: 'anyone' },
);

/**
 * Signs in: checks the credentials and answers a token that carries the account's role, administrator when its email is one of the
 * administrators' (`administratorEmails`, read when a sign-in is made: docs/adr/0033). Nothing changes, nothing is recorded.
 */
export const signIn = command(
  'SignIn',
  (
    accounts: IAccountRepository,
    passwords: IPasswordHasher,
    tokens: ISessionTokens,
    administratorEmails: () => readonly string[],
  ) =>
    async ({ email, password }: { email: string; password: string }) => {
      const address = Email.create(email);
      const account = address.isSuccess() ? await accounts.findByEmail(address.data.value) : undefined;
      if (!account || !(await passwords.matches(password, account.passwordHash))) {
        return Result.fail(new NotAllowedException('Groups', WRONG_CREDENTIALS));
      }
      return Result.ok({ token: tokens.issue(account.id, account.roleAmong(administratorEmails())) });
    },
  { caller: 'anyone' },
);

/** Reads the caller's own account. Nobody reads another's: the caller's id is the only one asked for. */
export const getMyAccount = query('GetMyAccount', (accounts: IAccountQueries) => async (_input: void, context) => {
  const account = await accounts.findAccount(callerOf(context));
  if (!account) return Result.fail(new NotFoundException('Groups', 'There is no account for this caller'));
  return Result.ok(account);
});
