import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';

import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { DecideContestCommandEvent } from '@Contexts/Settlements/Application/Commands/DecideContest/DecideContestCommandEvent';

/**
 * An administrator decides a contested settlement (request 33): the money arrived, and it is paid again, or it did not, and it is
 * annulled. Only an administrator may; the book decides that the settlement is contested, once. The decision is an entry of the
 * administrators' log, written with the book in one transaction, and what the book recorded is published with the save.
 */
export class DecideContestCommandHandler extends CommandHandler<DecideContestCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private clock: Clock,
  ) {
    super();
  }

  /** What only an administrator may do is refused to anyone else (403). */
  protected async guard(_: DecideContestCommandEvent, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId || auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Settlements', 'Only an administrator decides a contest'));
    }
    return Result.ok();
  }

  async execute(event: DecideContestCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    // The guard let only an administrator through: their id is the caller's.
    const administrator = context.auth.subjectId!;

    const { settlementId, paid } = event.payload;
    const book = await this.books.findBySettlementId(settlementId);
    if (!book) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));

    const decided = book.decideContest({ settlementId, paid, administrator }, this.clock());
    if (decided.isFailure()) return Result.fail(decided.error);

    const saved = await this.books.save(book);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(book, context);
    return Result.ok(settlementId);
  }
}
