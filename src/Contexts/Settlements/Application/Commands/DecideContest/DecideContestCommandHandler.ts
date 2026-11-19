import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { DecideContestCommandEvent } from '@Contexts/Settlements/Application/Commands/DecideContest/DecideContestCommandEvent';

/**
 * An administrator decides a contested settlement (request 33, ADR 24): paid, when the money arrived, or annulled, when it did
 * not. Only an administrator decides, and only a contested settlement, once. The decision is kept in the administrators' log in
 * the transaction of the decision: the book saves it with the settlement, and no one but an administrator reads the log.
 */
export class DecideContestCommandHandler extends CommandHandler<DecideContestCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  /** Administrators only (request 33): a caller who is not one is refused before anything runs. */
  protected async guard(_: DecideContestCommandEvent, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Settlements', 'Only an administrator may do this'));
    }
    return Result.ok();
  }

  async execute({ payload }: DecideContestCommandEvent, context: ExecutionContext): Promise<IResult> {
    // The guard let only an administrator through, who is signed in: the id is the one the transport says it is.
    const { subjectId } = context.auth;
    if (!subjectId) return Result.fail(new NotAllowedException('Settlements', 'Authentication required'));

    const settlementId = new Id(payload.settlementId);
    const book = await this.books.findBySettlement(settlementId);
    if (!book) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));

    const decided = book.decideContest({ settlementId, by: new Id(subjectId), paid: payload.paid, at: this.clock() });
    if (decided.isFailure()) return decided;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok();
  }
}
