import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { LeaveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/LeaveGroup/LeaveGroupCommandEvent';

/**
 * A signed-in member leaves a group once their balance in it is 0; the owner never does. For anyone who is not a member the
 * group does not exist. The balance is read from Ledger through the port Groups owns (ADR 4), inside the command's
 * transaction; the group decides and keeps the member as a former one, so the expenses they were in still say who they were.
 */
export class LeaveGroupCommandHandler extends CommandHandler<LeaveGroupCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private balances: IMemberBalances,
    private clock: Clock,
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
    const left = group.leave({ accountId: caller.data, balance, now: this.clock() });
    if (left.isFailure()) return left;

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(group, context);
    return Result.ok();
  }
}
