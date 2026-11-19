import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Decided, Decision, decided } from '@Architecture/Domain/Lite/Decision';
import { Email } from '@SharedKernel/Domain';

import { EmailAlreadyUsedException } from './AccountExceptions';
import { Account } from './Account';
import { AccountName } from './AccountName';
import { AdministratorLogEntry } from './AdministratorLogEntry';
import { Password } from './Password';

/** What a sign-up says: the email (already read as one), the password as typed and as hashed, and the name. */
export interface SignUpCommand {
  email: Email;
  password: string;
  passwordHash: string;
  name: string;
}

/**
 * Sign-up, as the storm decided it: an email no account uses, a password of at least 8 characters, a name of 1 to 60
 * characters that is not only spaces. `existing` is the account already holding the email, if any, that the shell
 * loaded through the repository. The account is made here, its creation recorded.
 */
export const decideSignUp: Decision<Account, SignUpCommand, never, Account | undefined> = (existing, command, now) => {
  if (existing) return Result.fail(new EmailAlreadyUsedException());
  const password = Password.create(command.password);
  if (password.isFailure()) return password;
  const name = AccountName.create(command.name);
  if (name.isFailure()) return name;
  return decided(
    Account.create({ email: command.email, name: name.data, passwordHash: command.passwordHash, at: now }),
  );
};

/**
 * Signing in is not a fact of the domain (the storm): it checks the credentials and answers the account, and changes
 * nothing. An unknown email and a wrong password are the same refusal, so nobody learns which emails have accounts.
 */
export const decideSignIn = (
  account: Account | undefined,
  { passwordMatches }: { passwordMatches: boolean },
): IResult<Decided<Account>> => {
  if (!account || !passwordMatches) return Result.fail(new NotAllowedException('Groups', 'Wrong email or password'));
  return decided(account);
};

/**
 * Whether an account is an administrator of the platform (request 33): its email is one of the administrators' emails the server is started
 * with, whatever the case. Nobody becomes one otherwise: no command makes one. Pure: the list is given.
 */
export const isAdministratorAccount = (account: Account, administratorEmails: readonly string[]): boolean =>
  administratorEmails.some(email => email.trim().toLowerCase() === account.email.value);

/** Who asks for a suspension or a reinstatement: the caller, and whether it is an administrator (request 33, request 34). */
export interface AdministrationCommand {
  by: string;
  administrator: boolean;
}

const ONLY_ADMINISTRATORS = 'Only an administrator may suspend or reinstate an account';

/**
 * Suspending an account (request 34): only an administrator may, and an account that is not there is not found. Suspending an account that is
 * suspended already changes nothing, so it answers no entry of the administrators' log; otherwise it answers the entry the change is logged by,
 * and the use case suspends the account with `Account.suspend` in the same transaction.
 */
export const decideSuspendAccount: Decision<
  AdministratorLogEntry | undefined,
  AdministrationCommand,
  never,
  Account | undefined
> = (account, { by, administrator }, now) => {
  if (!administrator) return Result.fail(new NotAllowedException('Groups', ONLY_ADMINISTRATORS));
  if (!account) return Result.fail(new NotFoundException('Groups', 'No account is found'));
  if (account.isSuspended) return decided(undefined);
  return decided(AdministratorLogEntry.of({ by, action: 'suspended', subjectId: account._id.value, at: now }));
};

/**
 * Reinstating an account (request 34): as a suspension, the other way round. An account that is not suspended changes nothing and answers no entry.
 */
export const decideReinstateAccount: Decision<
  AdministratorLogEntry | undefined,
  AdministrationCommand,
  never,
  Account | undefined
> = (account, { by, administrator }, now) => {
  if (!administrator) return Result.fail(new NotAllowedException('Groups', ONLY_ADMINISTRATORS));
  if (!account) return Result.fail(new NotFoundException('Groups', 'No account is found'));
  if (!account.isSuspended) return decided(undefined);
  return decided(AdministratorLogEntry.of({ by, action: 'reinstated', subjectId: account._id.value, at: now }));
};
