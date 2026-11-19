import { DomainEvent } from '@Architecture/Domain';

/**
 * A settlement was recorded in cash by its payee (request 12): `payer` paid `payee` `amount`. Recorded by `SettlementBook.recordCash`
 * and published after the book is saved. Nothing reacts to it yet, so it is not an integration event.
 */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/**
 * A payment through the provider was requested (request 13): the settlement is pending at the provider, and counts as paid for what
 * is still owed until the provider says otherwise (ADR 12). Recorded by `SettlementBook.requestPayment`, published after the save.
 */
export class PaymentRequestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/**
 * A payment through the provider succeeded (request 13): the settlement is paid, and the balances count it from now on. Recorded by
 * `SettlementBook.settlePayment`, published after the save; nothing reacts to it yet, so it is not an integration event (ADR 12).
 */
export class SettlementPaidEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/**
 * A refund of a settlement paid through the provider was requested (request 15): the money has not gone back yet, so the settlement is
 * `refunding` and the balances still count it. Recorded by `SettlementBook.requestRefund`, published after the save; nothing reacts to
 * it yet, so it is not an integration event (ADR 13).
 */
export class RefundRequestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/**
 * The provider says a settlement through it is refunded (request 15): the settlement is refunded, and the balances no longer count it,
 * as they were before it was paid. Recorded by `SettlementBook.settlePayment`, published after the save (ADR 13).
 */
export class SettlementRefundedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/**
 * A payment through the provider failed (request 13): the settlement is failed, the balances never count it, and what it held is
 * freed. Recorded by `SettlementBook.settlePayment`, published after the save (ADR 12).
 */
export class SettlementFailedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/**
 * The settlements of a group merged into another were taken into this group's book (request 31): the book's settlements are the group kept's
 * from then on, each with its status and history. Recorded by `SettlementBook.absorb` and published after the move; nothing reacts to it.
 */
export class SettlementBookMergedEvent extends DomainEvent<{ groupId: string; mergedGroupId: string }> {}
