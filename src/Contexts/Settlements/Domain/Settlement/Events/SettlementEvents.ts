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
