import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { ArchiveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/ArchiveGroup/ArchiveGroupCommandEvent';

/**
 * The owner archives a group (request 27, ADR 20). Every member's balance is asked of Ledger and whether a payment of any
 * member waits at the provider is asked of Settlements, inside this command's transaction, and the group decides: it is
 * archived once every balance is 0 and nothing waits, and is refused otherwise, or for anyone but its owner. For anyone who
 * is not a member of the group, the group does not exist.
 */
export class ArchiveGroupCommandHandler extends CommandHandler<ArchiveGroupCommandEvent> {
  constructor(
    private readonly groups: IGroupRepository,
    private readonly memberBalances: IMemberBalances,
    private readonly waitingPayments: IWaitingPayments,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: ArchiveGroupCommandEvent, context: ExecutionContext): Promise<IResult<undefined>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;

    const group = await this.groups.findById(new Id(payload.groupId));
    if (!group || !group.hasMember(caller.data)) return Result.fail(new NotFoundException('Groups', 'Group not found'));

    const members = group.members.map(member => member.accountId.value);
    const balances: number[] = [];
    let paymentWaiting = false;
    for (const member of members) {
      balances.push(await this.memberBalances.balanceOf(payload.groupId, member));
      paymentWaiting ||= await this.waitingPayments.hasWaitingPayments(payload.groupId, member);
    }
    const archived = group.archive({ accountId: caller.data, balances, paymentWaiting, at: this.clock() });
    if (archived.isFailure()) return archived;

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(group, context);
    return Result.ok(undefined);
  }
}
