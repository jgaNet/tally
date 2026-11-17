import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';

import { ReceivePaymentWebhookCommandEvent } from '@Contexts/Settlements/Application/Commands/ReceivePaymentWebhook/ReceivePaymentWebhookCommandEvent';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';

/**
 * The provider sends its webhooks, so anyone may ask: the signature, checked by the transport before this command is published, is
 * the proof. The payment the webhook is about is found by its id at the provider; a payment Tally does not know changes nothing, and
 * a webhook that changes nothing is acknowledged all the same, so that the provider stops sending it. A status that changes something
 * is kept in the settlement's history, at the time Tally learned it: the clock's, read when the webhook is decided.
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

  async execute({ payload }: ReceivePaymentWebhookCommandEvent, context: ExecutionContext): Promise<IResult> {
    const book = await this.books.findByProviderPaymentId(payload.paymentId);
    if (!book) return Result.ok();
    if (!book.receivePayment(payload.paymentId, payload.status, this.clock())) return Result.ok();

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(book, context);
    return Result.ok();
  }
}
