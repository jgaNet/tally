import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { ArchiveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/ArchiveGroup/ArchiveGroupCommandEvent';

/**
 * A signed-in member archives a group: only its owner may, once every balance in it is 0 and no payment in it waits at the provider
 * (request 27). For anyone who is not a member the group does not exist. The balances and the waiting payments are read inside the
 * command's transaction, through the ports Groups owns (ADR 4, ADR 18), and the group decides: an archived group is archived once,
 * and then every change in it is refused by the one rule, GroupArchived.
 */
export class ArchiveGroupCommandHandler extends CommandHandler<ArchiveGroupCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private balances: IMemberBalances,
    private waiting: IWaitingPayments,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: ArchiveGroupCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const group = await this.groups.findById(new Id(payload.groupId));
    if (!group || !group.isMember(caller.data)) {
      return Result.fail(new NotFoundException('Groups', 'Group not found', { id: payload.groupId }));
    }

    const archived = group.archive({
      accountId: caller.data,
      balances: await this.balances.allBalancesOf(payload.groupId),
      paymentWaiting: await this.waiting.waitingIn(payload.groupId),
      now: this.clock(),
    });
    if (archived.isFailure()) return archived;

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(group, context);
    return Result.ok();
  }
}
