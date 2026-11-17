import { DomainEvent } from '@Architecture/Domain';

/** The fields every settlement event names: the settlement, its group, who paid whom, and how much. */
interface SettlementFacts {
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}

/** A settlement was recorded in cash: its id, its group, who paid whom, and how much. It is counted by the balances at once. */
export class SettlementRecordedEvent extends DomainEvent<SettlementFacts> {}

/** A payment through the provider was requested: the settlement waits for the provider, and is not counted until it succeeds. */
export class PaymentRequestedEvent extends DomainEvent<SettlementFacts> {}

/** A payment through the provider succeeded: the settlement is paid, and the balances count it, once. */
export class SettlementPaidEvent extends DomainEvent<SettlementFacts> {}

/** A payment through the provider failed: the settlement is failed, never counted, and no longer waiting. */
export class SettlementFailedEvent extends DomainEvent<SettlementFacts> {}
