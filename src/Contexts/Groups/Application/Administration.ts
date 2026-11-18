import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IAdministratorChanges } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorChanges';
import { IAdministratorDecisions } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';

/**
 * Reads the administrators' log, the oldest first (request 33, docs/adr/0033; request 34, docs/adr/0034): the decisions Settlements keeps
 * and the changes Groups made to accounts, in the order they were made. Only an administrator reads it: for anyone else, signed in or
 * not, the log does not exist. Anonymous callers are refused by the transport before this runs (`401`).
 */
export const getAdministratorsLog = query(
  'GetAdministratorsLog',
  (changes: IAdministratorChanges, decisions: IAdministratorDecisions) => async (_input: void, context) => {
    // For anyone who is not an administrator the log does not exist (docs/adr/0033).
    if (context.auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Groups', 'There is no such log'));
    const entries = [...(await changes.changesOf()), ...(await decisions.decisionsOf())];
    return Result.ok(entries.sort((earlier, later) => (earlier.at < later.at ? -1 : earlier.at > later.at ? 1 : 0)));
  },
);

/** What an administrator asks: the account to suspend or to reinstate, by its id. */
export interface AccountSuspensionInput {
  id: string;
}

/**
 * An administrator suspends an account (request 34, docs/adr/0034): from then on it is refused every expense, recurring expense, cash
 * settlement, provider payment and netting it starts, in every group, and its recurring expenses wait. Nothing is written in any group. It
 * is logged to the administrators' log. Suspending an account already suspended changes nothing and logs nothing. Only an administrator
 * may (`NotAllowed` for anyone else, signed in); an account that does not exist is `NotFound`.
 */
export const suspendAccount = command(
  'SuspendAccount',
  (accounts: IAccountRepository, clock: Clock) =>
    async ({ id }: AccountSuspensionInput, context) => {
      if (context.auth.role !== Role.ADMIN) {
        return Result.fail(new NotAllowedException('Groups', 'Only an administrator suspends an account'));
      }
      const account = await accounts.findById(id);
      if (!account) return Result.fail(new NotFoundException('Groups', 'There is no such account'));

      const changed = account.suspend({ by: callerOf(context), at: clock() });
      if (!changed) return Result.ok(undefined);

      const saved = await accounts.save(account);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(account, context);
      return Result.ok(undefined);
    },
);

/**
 * An administrator reinstates a suspended account (request 34, docs/adr/0034): it may again do what it could, and its recurring expenses
 * record the days that came while it was suspended at the job's next run. Reinstating an account that is not suspended changes nothing
 * and logs nothing. Only an administrator may (`NotAllowed` for anyone else); an account that does not exist is `NotFound`.
 */
export const reinstateAccount = command(
  'ReinstateAccount',
  (accounts: IAccountRepository, clock: Clock) =>
    async ({ id }: AccountSuspensionInput, context) => {
      if (context.auth.role !== Role.ADMIN) {
        return Result.fail(new NotAllowedException('Groups', 'Only an administrator reinstates an account'));
      }
      const account = await accounts.findById(id);
      if (!account) return Result.fail(new NotFoundException('Groups', 'There is no such account'));

      const changed = account.reinstate({ by: callerOf(context), at: clock() });
      if (!changed) return Result.ok(undefined);

      const saved = await accounts.save(account);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(account, context);
      return Result.ok(undefined);
    },
);
