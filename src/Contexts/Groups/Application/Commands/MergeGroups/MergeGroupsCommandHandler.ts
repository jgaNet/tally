import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { MergeGroupsCommandEvent } from '@Contexts/Groups/Application/Commands/MergeGroups/MergeGroupsCommandEvent';

/**
 * The owner of two groups merges one into the other (request 31, ADR 23). Both groups are read in this command's transaction,
 * and whether a payment waits at the provider in the group merged is asked of Settlements in it too; the group kept decides,
 * and the group merged is forgotten in the same write, so it is gone at once. For a caller who is not a member of either, that
 * group does not exist. What Ledger and Settlements hold of the group merged moves in their reactions to GroupsMerged.
 */
export class MergeGroupsCommandHandler extends CommandHandler<MergeGroupsCommandEvent> {
  constructor(
    private readonly groups: IGroupRepository,
    private readonly waitingPayments: IWaitingPayments,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: MergeGroupsCommandEvent, context: ExecutionContext): Promise<IResult<undefined>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const kept = await this.groups.findById(new Id(payload.groupId));
    if (!kept || !kept.hasMember(caller.data)) return Result.fail(new NotFoundException('Groups', 'Group not found'));
    const merged = payload.from === payload.groupId ? kept : await this.groups.findById(new Id(payload.from));
    if (!merged || !merged.hasMember(caller.data)) {
      return Result.fail(new NotFoundException('Groups', 'Group not found'));
    }

    let paymentWaiting = false;
    for (const member of merged.members) {
      paymentWaiting ||= await this.waitingPayments.hasWaitingPayments(payload.from, member.accountId.value);
    }
    const done = kept.merge({ merged, accountId: caller.data, paymentWaiting, at: this.clock() });
    if (done.isFailure()) return done;

    const forgotten = await this.groups.save(merged);
    if (forgotten.isFailure()) return forgotten;
    const saved = await this.groups.save(kept);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(kept, context);
    return Result.ok(undefined);
  }
}
