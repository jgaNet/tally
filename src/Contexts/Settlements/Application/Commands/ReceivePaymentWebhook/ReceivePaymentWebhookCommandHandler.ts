import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';

import { ReceivePaymentWebhookCommandEvent } from '@Contexts/Settlements/Application/Commands/ReceivePaymentWebhook/ReceivePaymentWebhookCommandEvent';
import { ISettlementAuditLog } from '@Contexts/Settlements/Application/Ports/ISettlementAuditLog';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';

/**
 * The provider sends its webhooks, so anyone may ask: the signature, checked by the transport before this command is published, is
 * the proof. The payment the webhook is about is found by its id at the provider; a payment Tally does not know changes nothing, and
 * a webhook that changes nothing is acknowledged all the same, so that the provider stops sending it. A status that changes something
 * is kept in the settlement's history, at the time Tally learned it: the clock's, read when the webhook is decided. The money a webhook
 * starts or stops counting is audited in the same transaction, at that time (request 28).
 */
export class ReceivePaymentWebhookCommandHandler extends CommandHandler<ReceivePaymentWebhookCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private clock: Clock,
    private audit: ISettlementAuditLog,
  ) {
    super();
  }

  anyoneMayAsk(): boolean {
    return true;
  }

  async execute({ payload }: ReceivePaymentWebhookCommandEvent, context: ExecutionContext): Promise<IResult> {
    const book = await this.books.findByProviderPaymentId(payload.paymentId);
    if (!book) return Result.ok();
    const now = this.clock();
    if (!book.receivePayment(payload.paymentId, payload.status, now)) return Result.ok();

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;
    for (const move of book.moneyMovedSinceRead) {
      await this.audit.record(move.settlement.groupId.value, {
        id: `${move.action}:${move.settlement.id.value}`,
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
