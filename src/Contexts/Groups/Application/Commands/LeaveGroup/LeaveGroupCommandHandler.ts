import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { LeaveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/LeaveGroup/LeaveGroupCommandEvent';

/**
 * Leaving a group: a signed-in member leaves it whatever their balance (request 20). To anyone who is not a member the
 * group does not exist. The balance is asked of Ledger, and whether a payment of theirs waits at the provider of
 * Settlements, through the ports this context owns, when this decides; the group refuses the owner always, and a
 * member with a payment waiting. Otherwise the balance passes to the owner in the same step. The group is saved with
 * what it recorded, BalancePassed and MemberLeft, in one transaction, which holds the file's turn (ADR 4, ADR 11), so an
 * expense or a settlement at the same moment is either counted in what passes or refused. Its answer is the group's id.
 */
export class LeaveGroupCommandHandler extends CommandHandler<LeaveGroupCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private balances: IMemberBalances,
    private payments: IWaitingPayments,
  ) {
    super();
  }

  async execute(event: LeaveGroupCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);
    const leaver = caller.data.value;

    const group = await this.groups.findById(event.payload.groupId);
    if (!group || !group.isMember(leaver)) return Result.fail(new NotFoundException('Groups', 'Group not found'));

    const balance = await this.balances.balanceOf(group._id.value, leaver);
    const paymentWaiting = await this.payments.hasWaitingPaymentOf(group._id.value, leaver);
    const left = group.leave({ accountId: leaver, balance, paymentWaiting });
    if (left.isFailure()) return Result.fail(left.error);

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(group, context);
    return Result.ok(group._id.value);
  }
}
