import { Id, IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command } from '@Architecture/Application/Lite/UseCase';
import { Role } from '@SharedKernel/Domain';

import { IAccountStore } from '@Contexts/Groups/Application/IAccountStore';
import { IAdministratorActionLog } from '@Contexts/Groups/Application/IAdministratorActionLog';
import { NotAnAdministratorException } from '@Contexts/Groups/Domain/Account/AdministratorExceptions';
import { NoSuchAccountException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/**
 * Suspends an account (feature 34, request 34, the storm's `SuspendAccount`): an administrator only (`403` to anyone else, and the account
 * is not looked at), and the account must be there (`404`). A suspended account starts nothing in any group until it is reinstated, which
 * the other contexts refuse by AccountSuspended. An account already suspended changes nothing: no save, no entry, no event. Otherwise the
 * account is saved at the version it was read at, its entry goes into the administrators' log in the same transaction, and what it recorded
 * (AccountSuspended) goes out with the commit. Nothing is written in any group. Answers nothing (`204`).
 */
export const suspendAccount = command(
  'SuspendAccount',
  (accounts: IAccountStore, actions: IAdministratorActionLog, clock: Clock) =>
    async (accountId: string, context): Promise<IResult<void>> => {
      if (context.auth.role !== Role.ADMIN) return Result.fail(new NotAnAdministratorException());
      const account = await accounts.find(accountId);
      if (!account) return Result.fail(new NoSuchAccountException());

      const now = clock();
      if (!account.suspend(now)) return Result.ok(undefined);
      await accounts.save(account);
      await actions.record({
        id: Id.generate().value,
        at: now.toISOString(),
        by: callerOf(context),
        action: 'suspended',
        subjectId: accountId,
      });
      await publishDomainEvents(account, context);
      return Result.ok(undefined);
    },
);

/**
 * Reinstates an account (feature 34, request 34, the storm's `ReinstateAccount`): the same rules as a suspension, the other way round. An
 * account that is not suspended changes nothing; otherwise it is saved, its entry (`reinstated`) goes into the administrators' log in the
 * transaction, and AccountReinstated goes out with the commit. Answers nothing (`204`).
 */
export const reinstateAccount = command(
  'ReinstateAccount',
  (accounts: IAccountStore, actions: IAdministratorActionLog, clock: Clock) =>
    async (accountId: string, context): Promise<IResult<void>> => {
      if (context.auth.role !== Role.ADMIN) return Result.fail(new NotAnAdministratorException());
      const account = await accounts.find(accountId);
      if (!account) return Result.fail(new NoSuchAccountException());

      const now = clock();
      if (!account.reinstate(now)) return Result.ok(undefined);
      await accounts.save(account);
      await actions.record({
        id: Id.generate().value,
        at: now.toISOString(),
        by: callerOf(context),
        action: 'reinstated',
        subjectId: accountId,
      });
      await publishDomainEvents(account, context);
      return Result.ok(undefined);
    },
);
