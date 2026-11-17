import { DomainEvent } from '@Architecture/Domain';

/** A settlement was recorded in a group's book, in cash: it exists under the id it was born with, paid by the payer to the payee. */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** A payment through the provider was requested: the settlement is kept pending, and the payer may pay at the provider's link. */
export class PaymentRequestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** The provider said the payment succeeded: the settlement is paid, and the balances count it. */
export class SettlementPaidEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** The provider said the payment failed: the settlement is failed, and what it held is free again. */
export class SettlementFailedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}
