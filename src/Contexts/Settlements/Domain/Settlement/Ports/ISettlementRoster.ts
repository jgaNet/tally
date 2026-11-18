import { SettlementAuditEntry } from '@Contexts/Settlements/Domain/Settlement/SettlementAudit';

/**
 * What the settlements of a group do to each member's balance, as Settlements' read model gives it to the other contexts
 * (ADR 10): a port Settlements owns the read of, answered over its own table. `change` is what the member's balance moves by:
 * a payer's is raised by what they paid, a payee's lowered by what they were paid. Each settlement moves two balances by the
 * same amount in opposite directions, so the changes of one answer add up to 0; a member no settlement has moved is absent.
 * Read in one statement, so a settlement is counted whole or not at all.
 */
export interface SettledChange {
  readonly memberId: string;
  readonly change: number;
}

export interface ISettlementRoster {
  settledOf(groupId: string): Promise<SettledChange[]>;
  /**
   * The audit entries of the group's settlements, the oldest first (feature 28, ADR 23): each change of a settlement's money that Settlements
   * made, as it was written in the change's transaction. A group with none answers [].
   */
  auditOf(groupId: string): Promise<SettlementAuditEntry[]>;
}
