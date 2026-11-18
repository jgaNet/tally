import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command } from '@Architecture/Application/Lite/UseCase';

import { IAccountStore } from '@Contexts/Groups/Application/IAccountStore';
import { IGroupStore } from '@Contexts/Groups/Application/IGroupStore';
import { IWaitingPayments } from '@Contexts/Groups/Application/IMemberBalances';
import { AccountNotFoundException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/**
 * Deletes the signed-in person's own account (feature 35, request 35, the storm's `DeleteAccount`): the account is there for the caller,
 * or the caller is signed out at once (`404`). The two facts the deletion is decided by are read in the same transaction: whether the
 * account owns a group that has another member (Groups' own), and whether a payment through the provider it pays or receives waits (the
 * payments Settlements keeps, through the port Groups owns). The account decides: refused, and nothing changes, while either holds;
 * otherwise its email, name and password are erased and AccountDeleted goes out with the commit. Its id stays where the groups, the
 * expenses, the settlements and the audit name it; no group changes, and every balance stays as it was. Answers nothing (`204`).
 */
export const deleteAccount = command(
  'DeleteAccount',
  (accounts: IAccountStore, groups: IGroupStore, waiting: IWaitingPayments, clock: Clock) =>
    async (_: void, context): Promise<IResult<void>> => {
      const caller = callerOf(context);
      const account = await accounts.find(caller);
      if (!account) return Result.fail(new AccountNotFoundException());

      const deleted = account.delete(
        {
          ownsGroupWithOthers: await groups.ownsGroupWithOthers(caller),
          paymentWaiting: await waiting.hasPaymentWaitingOf(caller),
        },
        clock(),
      );
      if (deleted.isFailure()) return deleted;

      await accounts.save(account);
      await publishDomainEvents(account, context);
      return Result.ok(undefined);
    },
);
