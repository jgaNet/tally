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
 * The owner of a group decided who bears the provider's fee in it (request 38, docs/adr/0037). Recorded by `SettlementBook.setFeePolicy()`,
 * and published once the book is stored. No settlement asked for before changes: each keeps the fee it was asked with.
 */
export class FeePolicySetEvent extends DomainEvent<{
  groupId: string;
  borneBy: 'payer' | 'payee' | 'shared';
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

/**
 * The settlements of a merged group became the group kept's (request 31, docs/adr/0031): the book of the group kept takes them, and the
 * group merged's book is gone. Recorded by `SettlementBook.absorb()`, once the move is stored.
 */
export class SettlementBookMergedEvent extends DomainEvent<{ groupId: string; mergedGroupId: string }> {}

/**
 * A paid settlement through the provider was contested by its payee: the money did not reach them. Its effect on the balances is held, and
 * it waits, until an administrator decides it (request 33, docs/adr/0033). Recorded by `SettlementBook.contest()`.
 */
export class SettlementContestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}

/**
 * An administrator decided that a contested settlement's money did not arrive: the settlement is annulled, nothing counts it, and what was
 * owed is owed again (request 33, docs/adr/0033). Recorded by `SettlementBook.decideContest()`.
 */
export class SettlementAnnulledEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}
