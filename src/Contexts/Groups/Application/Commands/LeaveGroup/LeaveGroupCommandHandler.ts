import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { IGroupAuditLog } from '@Contexts/Groups/Application/Ports/IGroupAuditLog';
import { LeaveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/LeaveGroup/LeaveGroupCommandEvent';

/**
 * A signed-in member leaves a group whatever their balance in it; the owner never does, and a member with a payment waiting at
 * the provider may not (request 20). For anyone who is not a member the group does not exist. The balance and the waiting
 * payments are read inside the command's transaction, through the ports Groups owns (ADR 4): the balance passes to the owner in
 * the same step, and the member is kept as a former one, so the expenses they were in still say who they were. A balance that is not 0
 * is audited in the same transaction as the leave, by the member who left (request 28).
 */
export class LeaveGroupCommandHandler extends CommandHandler<LeaveGroupCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private balances: IMemberBalances,
    private waiting: IWaitingPayments,
    private clock: Clock,
    private audit: IGroupAuditLog,
  ) {
    super();
  }

  async execute({ payload }: LeaveGroupCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const group = await this.groups.findById(new Id(payload.groupId));
    if (!group || !group.isMember(caller.data)) {
      return Result.fail(new NotFoundException('Groups', 'Group not found', { id: payload.groupId }));
    }

    const balance = await this.balances.balanceOf(payload.groupId, caller.data);
    const paymentWaiting = await this.waiting.waitingOf(payload.groupId, caller.data);
    const now = this.clock();
    const left = group.leave({ accountId: caller.data, balance, paymentWaiting, now });
    if (left.isFailure()) return left;

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;
    if (balance !== 0) {
      await this.audit.record(payload.groupId, {
        id: `balance-passed:${payload.groupId}:${caller.data.value}:${now.toISOString()}`,
        at: now.toISOString(),
        by: caller.data.value,
        action: 'balance-passed',
        subjectId: caller.data.value,
        amount: balance,
      });
    }

    await this.publishDomainEvents(group, context);
    return Result.ok();
  }
}
