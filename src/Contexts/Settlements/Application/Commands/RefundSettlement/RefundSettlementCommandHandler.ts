import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { RefundSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RefundSettlement/RefundSettlementCommandEvent';

/**
 * The payee of a settlement paid through the provider refunds it whole (request 15, ADR 9): the caller is the payee. The book
 * checks the rules, the provider is asked for the refund with the payment's id and the settlement's id as the reference, and
 * the settlement is kept refunding once the provider has accepted it; nothing changes when the provider does not. The
 * balances still count a refunding settlement: they go back when the provider's webhook says it is refunded. For anyone who
 * is not a member of the group, the settlement does not exist. The book's version (CONC-OPTIMISTIC) makes a refund decided
 * at once with a webhook re-read and decided again.
 */
export class RefundSettlementCommandHandler extends CommandHandler<RefundSettlementCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly members: ISettlementMembers,
    private readonly provider: IPaymentProvider,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RefundSettlementCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const settlementId = new Id(payload.settlementId);
    const book = await this.books.findBySettlement(settlementId);
    if (!book) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));

    const groupArchived = await this.members.isArchived(book._id.value);
    const members = await this.members.currentMembers(book._id.value);
    const proposed = book.proposeRefund({ settlementId, caller: caller.data, members, groupArchived });
    if (proposed.isFailure()) return proposed;

    const accepted = await this.provider.refundPayment({
      paymentId: proposed.data.paymentId,
      reference: settlementId.value,
    });
    if (accepted.isFailure()) return accepted;

    const kept = book.keepRefund(proposed.data, this.clock());
    if (kept.isFailure()) return kept;
    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok();
  }
}
