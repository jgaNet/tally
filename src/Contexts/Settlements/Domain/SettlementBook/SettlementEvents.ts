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
