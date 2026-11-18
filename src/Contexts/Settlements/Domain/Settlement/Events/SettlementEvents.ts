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

/** A refund of a settlement paid through the provider was asked: the settlement is refunding, and still counted until the provider says so. */
export class RefundRequestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** The provider said the payment was refunded: the settlement is refunded, and the balances no longer count it. */
export class SettlementRefundedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** The payee said the money did not arrive: the settlement is contested, and held until an administrator decides it (request 33). */
export class SettlementContestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** An administrator decided the money did not arrive: the settlement is annulled, and what was owed is owed again (request 33). */
export class SettlementAnnulledEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** The book of the group merged into this one (request 31) is taken up: its settlements are this group's from the save on. */
export class SettlementBookMergedEvent extends DomainEvent<{ groupId: string; mergedGroupId: string }> {}
