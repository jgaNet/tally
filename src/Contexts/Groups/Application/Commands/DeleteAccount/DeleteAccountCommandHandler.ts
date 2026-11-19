import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { DeleteAccountCommandEvent } from '@Contexts/Groups/Application/Commands/DeleteAccount/DeleteAccountCommandEvent';

/**
 * A signed-in person deletes their own account (request 35, ADR 26). The groups it owns are Groups' own; the payments it waits
 * on at the provider are asked of Settlements (WaitingPayments), both inside this command's transaction. The Account decides
 * and refuses, and nothing changes then. Once deleted, its name, its email and the facts Groups kept of them are erased in the
 * same transaction; its id, its memberships and every balance stay.
 */
export class DeleteAccountCommandHandler extends CommandHandler<DeleteAccountCommandEvent> {
  constructor(
    private readonly accounts: IAccountRepository,
    private readonly groups: IGroupRepository,
    private readonly waitingPayments: IWaitingPayments,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(_: DeleteAccountCommandEvent, context: ExecutionContext): Promise<IResult<undefined>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const account = await this.accounts.findById(caller.data);
    if (!account) return Result.fail(new NotFoundException('Groups', 'Account not found'));

    const deleted = account.delete({
      at: this.clock(),
      ownsAGroupWithMembers: await this.groups.ownsAGroupWithOtherMembers(caller.data),
      paymentWaiting: await this.waitingPayments.hasWaitingPaymentsAnywhere(caller.data.value),
    });
    if (deleted.isFailure()) return deleted;

    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(account, context);
    return Result.ok(undefined);
  }
}
