import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { IAccountTraces } from '@Contexts/Groups/Application/Ports/IAccountTraces';
import { DeleteAccountCommandEvent } from '@Contexts/Groups/Application/Commands/DeleteAccount/DeleteAccountCommandEvent';

/**
 * A signed-in person deletes their own account (request 35). The account decides: it refuses while it owns a group another member is in, or
 * while a payment it pays or receives through the provider waits (request 13, 15, 33); both are read inside the command's transaction, through
 * the ports Groups owns. Once it is deleted its name and email are erased from the account and from the facts a sign-up left, in the same
 * transaction; its id, and its places in the groups, stay.
 */
export class DeleteAccountCommandHandler extends CommandHandler<DeleteAccountCommandEvent> {
  constructor(
    private accounts: IAccountRepository,
    private groups: IGroupRepository,
    private waiting: IWaitingPayments,
    private traces: IAccountTraces,
    private clock: Clock,
  ) {
    super();
  }

  async execute(_: DeleteAccountCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const account = await this.accounts.findById(caller.data);
    if (!account) return Result.fail(new NotFoundException('Groups', 'Account not found', { id: caller.data.value }));
    const held = { accountId: caller.data.value, email: account.email?.value ?? null };

    const deleted = account.delete({
      ownedWithOthers: (await this.groups.countOwnedWithOtherMembers(caller.data)) > 0,
      paymentWaiting: await this.waiting.waitingForAccount(caller.data),
      now: this.clock(),
    });
    if (deleted.isFailure()) return deleted;

    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return saved;
    await this.traces.erase(held);

    await this.publishDomainEvents(account, context);
    return Result.ok();
  }
}
