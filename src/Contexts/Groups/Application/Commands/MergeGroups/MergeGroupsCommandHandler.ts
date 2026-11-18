import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { MergeGroupsCommandEvent } from '@Contexts/Groups/Application/Commands/MergeGroups/MergeGroupsCommandEvent';

/**
 * A signed-in owner merges one of their groups into another (request 31). Both must be groups the caller is a member of, or the group does
 * not exist for them. The group kept decides, reading the group merged in the same transaction (`absorb`): the owner of both, one currency,
 * neither archived, and no payment waiting at the provider in the group merged (WaitingPayments, Settlements'). The write removes the group
 * merged and keeps the group kept; the contexts that hold the rest of it move it on GroupsMerged, published from the outbox after the commit.
 */
export class MergeGroupsCommandHandler extends CommandHandler<MergeGroupsCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private waiting: IWaitingPayments,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: MergeGroupsCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const kept = await this.groups.findById(new Id(payload.groupId));
    if (!kept || !kept.isMember(caller.data)) {
      return Result.fail(new NotFoundException('Groups', 'Group not found', { id: payload.groupId }));
    }
    const merged = await this.groups.findById(new Id(payload.from));
    if (!merged || !merged.isMember(caller.data)) {
      return Result.fail(new NotFoundException('Groups', 'Group not found', { id: payload.from }));
    }

    const absorbed = kept.absorb({
      accountId: caller.data,
      merged,
      paymentWaiting: await this.waiting.waitingIn(payload.from),
      now: this.clock(),
    });
    if (absorbed.isFailure()) return absorbed;

    const saved = await this.groups.saveMerged(kept, merged);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(kept, context);
    return Result.ok();
  }
}
