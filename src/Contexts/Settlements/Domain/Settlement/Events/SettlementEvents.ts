import { DomainEvent } from '@Architecture/Domain';

/** A settlement in cash was recorded: its id, its group, who paid whom, the amount, and when it was recorded. */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
  recordedAt: string;
}> {}

/** A payment through the provider was asked: its settlement, the link the payer pays at, and when it was asked (ADR 8). */
export class PaymentRequestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
  payUrl: string;
  requestedAt: string;
}> {}

/** The provider said the payment through a settlement succeeded: the settlement is paid, and the balances count it. */
export class SettlementPaidEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** The provider said the payment through a settlement failed: the settlement is failed, and it holds nothing. */
export class SettlementFailedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** The payee asked the provider to refund a settlement paid through it: it is refunding, and the balances still count it (ADR 9). */
export class RefundRequestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
  requestedAt: string;
}> {}

/** The provider said the payment through a settlement is refunded: the settlement is refunded, and the balances no longer count it. */
export class SettlementRefundedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}
