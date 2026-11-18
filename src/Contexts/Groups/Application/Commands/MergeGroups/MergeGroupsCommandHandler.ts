import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { MergeGroupsCommandEvent } from '@Contexts/Groups/Application/Commands/MergeGroups/MergeGroupsCommandEvent';

/**
 * Merging a group into another (request 31): the owner of both asks for it. To anyone who is not a member of both groups, the
 * group does not exist. Whether a payment through the provider in the group merged waits is asked of Settlements through the
 * port this context owns, when this decides; the group kept decides the rest (`merge`), and the two are saved in one
 * transaction, so the group merged is gone as soon as the merge is done. Its answer is the group kept's id.
 */
export class MergeGroupsCommandHandler extends CommandHandler<MergeGroupsCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private payments: IWaitingPayments,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: MergeGroupsCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);
    const merger = caller.data.value;
    const { groupId, from } = event.payload;

    const kept = await this.groups.findById(groupId);
    if (!kept || !kept.isMember(merger)) return Result.fail(new NotFoundException('Groups', 'Group not found'));
    const merged = await this.groups.findById(from);
    if (!merged || !merged.isMember(merger)) return Result.fail(new NotFoundException('Groups', 'Group not found'));

    const paymentsWaiting = await this.payments.hasWaitingPaymentIn(from);
    const merging = kept.merge({ askedBy: merger, merged, paymentsWaiting, at: this.clock() });
    if (merging.isFailure()) return Result.fail(merging.error);

    const saved = await this.groups.absorb(kept, merged);
    if (saved.isFailure()) return Result.fail(saved.error);

    await publishDomainEvents(kept, context);
    return Result.ok(kept._id.value);
  }
}
