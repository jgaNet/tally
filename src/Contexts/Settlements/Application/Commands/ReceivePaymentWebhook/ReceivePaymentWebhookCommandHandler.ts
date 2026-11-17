import { IResult, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';

import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { ReceivePaymentWebhookCommandEvent } from '@Contexts/Settlements/Application/Commands/ReceivePaymentWebhook/ReceivePaymentWebhookCommandEvent';

/**
 * The provider's webhook about a payment (request 13): the signature is the proof, checked at the transport over the body as
 * sent, before anything is decided, so anyone may ask for this command (the storm `pay-through-the-provider`, API-CALLER-AT-TRANSPORT).
 * The book holding the payment takes the provider's word: a pending payment succeeds or fails, once; a `refunded` moves a payment on
 * to refunded, once (request 15). A payment Tally does not know changes nothing, and a signed webhook is acknowledged whatever it says. The book is saved, and what it recorded is published,
 * only when it moved. Each status it moves to is dated by the clock, when Tally learned it (request 19), not by the provider's `at`.
 */
export class ReceivePaymentWebhookCommandHandler extends CommandHandler<ReceivePaymentWebhookCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private clock: Clock,
  ) {
    super();
  }

  anyoneMayAsk(): boolean {
    return true;
  }

  async execute(event: ReceivePaymentWebhookCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const book = await this.books.findByPaymentId(event.payload.paymentId);
    if (!book) return Result.ok();

    const received = book.receiveProviderUpdate(event.payload, this.clock());
    if (received.isFailure()) return Result.fail(received.error);
    if (!book.hasChanges()) return Result.ok();

    const saved = await this.books.save(book);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(book, context);
    return Result.ok();
  }
}
