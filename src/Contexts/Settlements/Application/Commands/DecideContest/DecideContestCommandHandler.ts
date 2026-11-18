import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import { DecideContestCommandEvent } from '@Contexts/Settlements/Application/Commands/DecideContest/DecideContestCommandEvent';
import { IAdministratorDecisionLog } from '@Contexts/Settlements/Application/Ports/IAdministratorDecisionLog';
import { ISettlementAuditLog } from '@Contexts/Settlements/Application/Ports/ISettlementAuditLog';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { auditIdOf } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * An administrator decides a contested settlement (request 33): paid, when the money arrived, and the settlement counts as it did before it
 * was contested; annulled, when it did not, and what was owed is owed again. Only an administrator decides: the refusal is the operation's.
 * The decision is written in the administrators' log, and a paid decision is audited, in the transaction of the decision, at the time Tally
 * learned it.
 */
export class DecideContestCommandHandler extends CommandHandler<DecideContestCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private clock: Clock,
    private audit: ISettlementAuditLog,
    private administratorLog: IAdministratorDecisionLog,
  ) {
    super();
  }

  protected async guard(_: DecideContestCommandEvent, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Settlements', 'Only an administrator decides a contest'));
    }
    return Result.ok();
  }

  async execute({ payload }: DecideContestCommandEvent, context: ExecutionContext): Promise<IResult> {
    if (!context.auth.subjectId) return Result.fail(new NotAllowedException('Settlements', 'Authentication required'));
    const administrator = new Id(context.auth.subjectId);

    const settlementId = new Id(payload.settlementId);
    const book = await this.books.findBySettlementId(settlementId);
    if (!book)
      return Result.fail(new NotFoundException('Settlements', 'Settlement not found', { id: payload.settlementId }));

    const now = this.clock();
    const decided = book.decideContest({ settlementId, administrator, paid: payload.paid, now });
    if (decided.isFailure()) return decided;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    for (const move of book.moneyMovedSinceRead) {
      await this.audit.record(book.groupId.value, {
        id: auditIdOf(move),
        at: now.toISOString(),
        by: move.by.value,
        action: move.action,
        subjectId: move.settlement.id.value,
        amount: move.settlement.amount,
      });
    }
    for (const decision of book.administratorDecisionsSinceRead) {
      await this.administratorLog.record({
        id: `${decision.action}:${decision.settlement.id.value}`,
        at: now.toISOString(),
        by: decision.by.value,
        action: decision.action,
        subjectId: decision.settlement.id.value,
      });
    }

    await this.publishDomainEvents(book, context);
    return Result.ok();
  }
}
