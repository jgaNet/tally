import { DomainEvent } from '@Architecture/Domain';

/** A settlement was recorded: its id, its group, who paid whom, and how much. It is counted by the balances at once. */
export class SettlementRecordedEvent extends DomainEvent<{
  settlementId: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
}> {}
