import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { ContestSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/ContestSettlement/ContestSettlementCommandEvent';

/**
 * The payee of a settlement paid through the provider contests it (request 33, ADR 24): the money did not reach them. The book
 * decides it: the caller must be the payee, once, while the payer and the payee are members, and the group not archived. A
 * contested settlement is held out of the balances and waits until an administrator decides it. For anyone who is not a member
 * of the group, the settlement does not exist. The book's version (CONC-OPTIMISTIC) makes a contest decided at once re-read it.
 */
export class ContestSettlementCommandHandler extends CommandHandler<ContestSettlementCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly members: ISettlementMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: ContestSettlementCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const settlementId = new Id(payload.settlementId);
    const book = await this.books.findBySettlement(settlementId);
    if (!book) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));

    const groupArchived = await this.members.isArchived(book._id.value);
    const members = await this.members.currentMembers(book._id.value);
    const contested = book.contest({ settlementId, caller: caller.data, members, groupArchived, at: this.clock() });
    if (contested.isFailure()) return contested;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok();
  }
}
