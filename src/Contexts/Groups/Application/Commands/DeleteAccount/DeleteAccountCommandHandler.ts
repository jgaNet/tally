import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { DeleteAccountCommandEvent } from '@Contexts/Groups/Application/Commands/DeleteAccount/DeleteAccountCommandEvent';

/**
 * A signed-in person deletes their own account (request 35). The account is found by the caller's id; the two facts its
 * deletion needs are read in the same transaction, through the ports this context owns: whether it owns a group that has
 * another member (the groups repository), and whether a payment through the provider it pays or receives has not ended
 * (Settlements, through WaitingPayments). The Account decides, and refuses by a failed Result with nothing changed. Otherwise
 * it is saved, its name and email erased from what Groups keeps about it, and AccountDeleted is published, in one transaction.
 * Its answer is the account's id.
 */
export class DeleteAccountCommandHandler extends CommandHandler<DeleteAccountCommandEvent> {
  constructor(
    private accounts: IAccountRepository,
    private groups: IGroupRepository,
    private payments: IWaitingPayments,
    private clock: Clock,
  ) {
    super();
  }

  async execute(_: DeleteAccountCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);
    const accountId = caller.data.value;

    const account = await this.accounts.findById(accountId);
    if (!account || account.isDeleted) return Result.fail(new NotFoundException('Groups', 'Account not found'));

    const decided = account.delete({
      at: this.clock(),
      ownsGroupWithMembers: await this.groups.hasOwnedGroupWithOtherMembers(accountId),
      paymentOpen: await this.payments.hasOpenPaymentOf(accountId),
    });
    if (decided.isFailure()) return Result.fail(decided.error);

    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(account, context);
    return Result.ok(accountId);
  }
}
