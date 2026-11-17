import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { RefundSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RefundSettlement/RefundSettlementCommandEvent';

/**
 * Refunding a settlement paid through the provider (request 15): the payee of a settlement that is paid asks the provider to
 * refund it, whole. The book decides first, against who asks, the status and the membership of both members, so a refused refund
 * never reaches the provider; then the provider is asked with the settlement's id as the reference, and the book keeps the
 * settlement refunding once the provider accepted it. A provider that does not accept the refund refuses it and nothing moves. To
 * anyone who is not a member the settlement does not exist. The book is saved and what it recorded is published with the save, in
 * one transaction; its answer is the settlement's id.
 */
export class RefundSettlementCommandHandler extends CommandHandler<RefundSettlementCommandEvent> {
  constructor(
    private settlementMembers: ISettlementMembers,
    private books: ISettlementBookRepository,
    private provider: IPaymentProvider,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: RefundSettlementCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const asker = caller.data.value;

    const { settlementId } = event.payload;
    const book = await this.books.findBySettlementId(settlementId);
    if (!book) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));

    const members = await this.settlementMembers.membersOf(book.groupId, asker);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));

    const proposed = book.proposeRefund({
      settlementId,
      asker,
      members: members.map(member => member.memberId),
    });
    if (proposed.isFailure()) return Result.fail(proposed.error);

    const accepted = await this.provider.refundPayment({
      paymentId: proposed.data.paymentId,
      reference: settlementId,
    });

    const kept = book.keepRefund(proposed.data, accepted, this.clock());
    if (kept.isFailure()) return Result.fail(kept.error);

    const saved = await this.books.save(book);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(book, context);
    return Result.ok(settlementId);
  }
}
