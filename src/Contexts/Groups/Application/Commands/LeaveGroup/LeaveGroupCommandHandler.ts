import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { LeaveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/LeaveGroup/LeaveGroupCommandEvent';

/**
 * Leaving a group: a signed-in member leaves it once their balance in it is 0 (request 9). To anyone who is not a
 * member the group does not exist. The balance is asked of Ledger through the port this context owns, when this
 * decides; the group refuses the owner always, and any balance that is not 0. The group is saved with what it
 * recorded, MemberLeft, in one transaction. Its answer is the group's id.
 */
export class LeaveGroupCommandHandler extends CommandHandler<LeaveGroupCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private balances: IMemberBalances,
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
    const left = group.leave({ accountId: leaver, balance });
    if (left.isFailure()) return Result.fail(left.error);

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(group, context);
    return Result.ok(group._id.value);
  }
}
