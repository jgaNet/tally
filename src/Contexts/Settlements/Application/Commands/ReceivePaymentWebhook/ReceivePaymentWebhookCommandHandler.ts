import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { ReceivePaymentWebhookCommandEvent } from '@Contexts/Settlements/Application/Commands/ReceivePaymentWebhook/ReceivePaymentWebhookCommandEvent';

/**
 * The provider tells Tally how a payment ended (ADR 8). Anyone may send it: the signature the transport checked is the proof.
 * A payment this group's book does not hold, or one that did not end, changes nothing; a webhook that changes a settlement
 * saves the book, and its facts are published after the commit. The status it moves to is learned now, by the clock the
 * wiring gives (request 19), not at the time the provider's body names.
 */
export class ReceivePaymentWebhookCommandHandler extends CommandHandler<ReceivePaymentWebhookCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  anyoneMayAsk(): boolean {
    return true;
  }

  async execute({ payload }: ReceivePaymentWebhookCommandEvent, context: ExecutionContext): Promise<IResult> {
    const book = await this.books.findByPaymentId(payload.paymentId);
    if (!book) return Result.ok();
    book.receivePayment({ paymentId: payload.paymentId, status: payload.status, at: this.clock() });
    if (book.unsaved.length === 0) return Result.ok();
    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(book, context);
    return Result.ok();
  }
}
