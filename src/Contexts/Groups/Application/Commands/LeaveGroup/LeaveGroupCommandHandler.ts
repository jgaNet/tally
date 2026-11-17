import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { LeaveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/LeaveGroup/LeaveGroupCommandEvent';

/**
 * A member leaves a group whatever their balance in it, and the owner stays. The balance is asked of Ledger when the member
 * leaves, inside this command's transaction (MemberBalances, ADR 4), and passes to the owner in the same step (request 20).
 * A payment of the member waiting at the provider is asked of Settlements the same way (WaitingPayments, ADR 13), and
 * refuses the leave until it has ended. For anyone who is not a member of the group, the group does not exist.
 */
export class LeaveGroupCommandHandler extends CommandHandler<LeaveGroupCommandEvent> {
  constructor(
    private readonly groups: IGroupRepository,
    private readonly memberBalances: IMemberBalances,
    private readonly waitingPayments: IWaitingPayments,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: LeaveGroupCommandEvent, context: ExecutionContext): Promise<IResult<undefined>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const group = await this.groups.findById(new Id(payload.groupId));
    if (!group || !group.hasMember(caller.data)) return Result.fail(new NotFoundException('Groups', 'Group not found'));

    const balance = await this.memberBalances.balanceOf(payload.groupId, caller.data.value);
    const paymentWaiting = await this.waitingPayments.hasWaitingPayments(payload.groupId, caller.data.value);
    const left = group.leave({ accountId: caller.data, balance, paymentWaiting, at: this.clock() });
    if (left.isFailure()) return left;

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(group, context);
    return Result.ok(undefined);
  }
}
