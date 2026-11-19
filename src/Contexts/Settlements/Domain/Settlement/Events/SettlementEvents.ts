import { DomainEvent } from '@Architecture/Domain';

/**
 * A settlement was recorded as paid: in cash, or by a netting (method `net`, request 32): its id, its group, who paid whom, the
 * amount, how it was made, and when it was recorded.
 */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
  method: 'cash' | 'net';
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

/**
 * The book of a group merged into this one was taken in (request 31, ADR 23): the group kept, the group merged, the
 * settlements that moved, and when. Each keeps its id, its status and its history; only its group changes.
 */
export class SettlementBookMergedEvent extends DomainEvent<{
  groupId: string;
  mergedGroupId: string;
  settlementIds: string[];
  mergedAt: string;
}> {}

/**
 * The payee of a settlement paid through the provider said the money did not reach them (request 33, ADR 24): the settlement is
 * contested, held out of the balances, and waits until an administrator decides it.
 */
export class SettlementContestedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
  contestedAt: string;
}> {}

/** An administrator decided a contested settlement was not paid: it is annulled, nothing counts it, and what was owed is owed again (request 33). */
export class SettlementAnnulledEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  payer: string;
  payee: string;
  amount: number;
}> {}

/** The owner of a group decided who bears the provider's fee from now on: the payer, the payee, or both, shared (request 38). */
export class FeePolicySetEvent extends DomainEvent<{
  groupId: string;
  borneBy: string;
  by: string;
  setAt: string;
}> {}
