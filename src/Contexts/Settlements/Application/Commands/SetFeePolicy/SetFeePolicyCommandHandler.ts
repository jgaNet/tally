import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SetFeePolicyCommandEvent } from '@Contexts/Settlements/Application/Commands/SetFeePolicy/SetFeePolicyCommandEvent';

/**
 * A signed-in member of a group decides who bears the provider's fee from now on (request 38, ADR 29). For anyone who is not a
 * member of the group, the group does not exist; a member who is not its owner is refused by OnlyTheOwnerSetsFeePolicy, and
 * nothing is changed. The book decides the policy and records FeePolicySet, in the transaction of the change.
 */
export class SetFeePolicyCommandHandler extends CommandHandler<SetFeePolicyCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly members: ISettlementMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: SetFeePolicyCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const role = await this.members.roleOf(payload.groupId, caller.data.value);
    if (role === null) return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    const groupArchived = await this.members.isArchived(payload.groupId);

    const book = await this.books.findByGroup(new Id(payload.groupId));
    const changed = book.setFeePolicy({
      borneBy: payload.borneBy,
      by: caller.data,
      callerIsOwner: role === 'owner',
      groupArchived,
      at: this.clock(),
    });
    if (changed.isFailure()) return changed;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok();
  }
}
