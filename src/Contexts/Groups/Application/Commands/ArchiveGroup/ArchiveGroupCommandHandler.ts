import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { ArchiveGroupCommandEvent } from '@Contexts/Groups/Application/Commands/ArchiveGroup/ArchiveGroupCommandEvent';

/**
 * Archiving a group (request 27): a signed-in member asks for it; to anyone who is not a member the group does not exist. The
 * balances, asked of Ledger, and whether a payment through the provider waits, asked of Settlements, are read through the ports
 * this context owns, when this decides, in the archive's own transaction. The owner archives it once every balance is 0 and no
 * payment waits; the group refuses the rest by its own rules, and GroupArchived when it is archived already. The group is saved
 * with what it recorded, GroupArchived, and the time is the application's clock. Its answer is the group's id.
 */
export class ArchiveGroupCommandHandler extends CommandHandler<ArchiveGroupCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private balances: IMemberBalances,
    private payments: IWaitingPayments,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: ArchiveGroupCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);
    const archiver = caller.data.value;

    const group = await this.groups.findById(event.payload.groupId);
    if (!group || !group.isMember(archiver)) return Result.fail(new NotFoundException('Groups', 'Group not found'));

    const balances = await this.balances.balancesOf(group._id.value);
    const paymentsWaiting = await this.payments.hasWaitingPaymentIn(group._id.value);
    const archived = group.archive({ askedBy: archiver, balances, paymentsWaiting, archivedAt: this.clock() });
    if (archived.isFailure()) return Result.fail(archived.error);

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(group, context);
    return Result.ok(group._id.value);
  }
}
