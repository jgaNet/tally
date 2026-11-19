import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import {
  decideReinstateAccount,
  decideSignIn,
  decideSignUp,
  decideSuspendAccount,
  isAdministratorAccount,
} from '@Contexts/Groups/Domain/Account/Account.decision';
import { EmailAlreadyUsedException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

import { AccountView, IAccountQueries } from './IAccountQueries';
import { Email, Role } from '@SharedKernel/Domain';

import { IAccessTokens } from './IAccessTokens';
import { IAdministratorDecisions } from './IAdministratorDecisions';
import { IAdministratorLog } from './IAdministratorLog';
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
 * unknown email are refused the same way. The token says the caller is an administrator when the account's email is one of the
 * administrators' (request 33), read when the sign-in comes.
 */
export const signIn = query(
  'SignIn',
  (
    accounts: IAccountRepository,
    passwords: IPasswordHasher,
    tokens: IAccessTokens,
    administratorEmails: () => readonly string[],
  ) =>
    async ({ email, password }: { email: string; password: string }) => {
      const address = Email.create(email);
      const account = address.isSuccess() ? await accounts.findByEmail(address.data) : undefined;
      const matches = await passwords.matches(password, account?.passwordHash);
      const decision = decideSignIn(account, { passwordMatches: matches });
      if (decision.isFailure()) return decision;
      const administrator = isAdministratorAccount(decision.data.state, administratorEmails());
      return Result.ok({ token: await tokens.issue(decision.data.state._id.value, administrator) });
    },
  { caller: 'anyone' },
);

/** A signed-in person reads their own account, and nobody else's. */
export const getMyAccount = query('GetMyAccount', (accounts: IAccountQueries) => async (_input: void, context) => {
  const account: AccountView | undefined = await accounts.accountOf(callerOf(context));
  if (!account) return Result.fail(new NotFoundException('Groups', 'No account is signed in'));
  return Result.ok(account);
});

/**
 * An administrator suspends an account (request 34): from then on it may not record an expense, set up a recurring expense, record a settlement
 * in cash, ask to pay through the provider or ask for a netting, in any group, and nothing in any group changes. Only an administrator may (any
 * other signed-in caller is refused with `NotAllowed`), and an account that is not there is not found. Suspending an account suspended already
 * changes nothing and writes no entry. Otherwise the account is saved at the version it was read at, and its entry of the administrators' log is
 * written in the same transaction (CONC-OPTIMISTIC, request 34). Answers nothing (`204`).
 */
export const suspendAccount = command(
  'SuspendAccount',
  (accounts: IAccountRepository, log: IAdministratorLog, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      return accounts.inTransaction(async () => {
        const account = await accounts.findById(id);
        const now = clock();
        const decision = decideSuspendAccount(
          account,
          { by: callerOf(context), administrator: context.auth.role === Role.ADMIN },
          now,
        );
        if (decision.isFailure()) return decision;
        const entry = decision.data.state;
        if (!account || !entry) return Result.ok(undefined);

        account.suspend(now);
        await accounts.save(account);
        await log.record(entry);
        await publishDomainEvents(account, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * An administrator reinstates a suspended account (request 34), as `SuspendAccount` suspends it: the same rule for who may, the same answers, and
 * an account that is not suspended changes nothing. Its entry of the administrators' log is written in the same transaction as the reinstatement.
 */
export const reinstateAccount = command(
  'ReinstateAccount',
  (accounts: IAccountRepository, log: IAdministratorLog, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      return accounts.inTransaction(async () => {
        const account = await accounts.findById(id);
        const now = clock();
        const decision = decideReinstateAccount(
          account,
          { by: callerOf(context), administrator: context.auth.role === Role.ADMIN },
          now,
        );
        if (decision.isFailure()) return decision;
        const entry = decision.data.state;
        if (!account || !entry) return Result.ok(undefined);

        account.reinstate(now);
        await accounts.save(account);
        await log.record(entry);
        await publishDomainEvents(account, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * An administrator reads the administrators' log, the oldest entry first (request 33, request 34): the decisions the administrators made on
 * settlements, which Settlements writes and Groups reads through its port, and the suspensions and reinstatements Groups writes itself. What only
 * an administrator reads does not exist for anyone else.
 */
export const getAdministratorsLog = query(
  'GetAdministratorsLog',
  (decisions: IAdministratorDecisions, own: IAdministratorLog) => async (_input: void, context) => {
    if (context.auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Groups', 'Nothing is found'));
    const lines = [...(await decisions.decisions()), ...(await own.entries())];
    // Stable: on the same instant, the decisions of Settlements come first, as they were written before any change of Groups' own.
    return Result.ok(lines.sort((earlier, later) => (earlier.at < later.at ? -1 : earlier.at > later.at ? 1 : 0)));
  },
);
