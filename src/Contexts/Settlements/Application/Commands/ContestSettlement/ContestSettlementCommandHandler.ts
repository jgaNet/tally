import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ContestSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/ContestSettlement/ContestSettlementCommandEvent';
import { ISettlementAuditLog } from '@Contexts/Settlements/Application/Ports/ISettlementAuditLog';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { auditIdOf } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * A signed-in member asks for a settlement paid through the provider to be contested: the caller must be its payee, and the settlement
 * must be paid through the provider, once, while it is paid, with both members still in the group. The book decides; a refusal changes
 * nothing. The contest is audited in the same transaction, at the time Tally learned it (request 33). For anyone who is not a member the
 * settlement does not exist.
 */
export class ContestSettlementCommandHandler extends CommandHandler<ContestSettlementCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private members: ISettlementMembers,
    private clock: Clock,
    private audit: ISettlementAuditLog,
  ) {
    super();
  }

  async execute({ payload }: ContestSettlementCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const settlementId = new Id(payload.settlementId);
    const book = await this.books.findBySettlementId(settlementId);
    if (!book) return Result.fail(notFound(payload.settlementId));
    const members = await this.members.membersOf(book.groupId.value);
    if (!members.includes(caller.data.value)) return Result.fail(notFound(payload.settlementId));
    const archived = await this.members.archivedOf(book.groupId.value);

    const now = this.clock();
    const contested = book.contest({ settlementId, caller: caller.data, members, archived, now });
    if (contested.isFailure()) return contested;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    for (const move of book.moneyMovedSinceRead) {
      await this.audit.record(book.groupId.value, {
        id: auditIdOf(move),
        at: now.toISOString(),
        by: move.by.value,
        action: move.action,
        subjectId: move.settlement.id.value,
        amount: move.settlement.settledAmount,
      });
    }

    await this.publishDomainEvents(book, context);
    return Result.ok();
  }
}

const notFound = (id: string) => new NotFoundException('Settlements', 'Settlement not found', { id });
