import { DomainEvent } from '@Architecture/Domain';

/**
 * A cash settlement was recorded by its payee (request 12, docs/adr/0013). Recorded by `SettlementBook.recordCash()`, and
 * published once the book is stored. No integration event carries it yet: no other context reacts to it in this request.
 */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}

/**
 * A settlement through the provider was requested: its payment is pending until the provider's webhook says it ended (request 13,
 * docs/adr/0014). Recorded by `SettlementBook.recordProviderPayment()`, and published once the book is stored.
 */
export class PaymentRequestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}

/**
 * A pending settlement's payment succeeded: the settlement is paid, and the balances count it from now on (request 13,
 * docs/adr/0014). Recorded by `SettlementBook.settleProviderPayment()`.
 */
export class SettlementPaidEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}

/**
 * A pending settlement's payment failed: the settlement is failed, the balances never count it, and what it held is free again
 * (request 13, docs/adr/0014). Recorded by `SettlementBook.settleProviderPayment()`.
 */
export class SettlementFailedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}

/**
 * A paid settlement through the provider was asked to be refunded by its payee: it is `refunding` until the provider's webhook says it
 * is refunded, and the balances still count it as paid (request 15, docs/adr/0015). Recorded by `SettlementBook.recordRefund()`.
 */
export class RefundRequestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}

/**
 * The provider says a settlement's payment was refunded: the settlement is `refunded`, and the balances no longer count it, as if it had
 * never been paid (request 15, docs/adr/0015). Recorded by `SettlementBook.settleProviderPayment()`, once.
 */
export class SettlementRefundedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}
