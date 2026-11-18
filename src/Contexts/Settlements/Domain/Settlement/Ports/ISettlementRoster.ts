import { SettlementAuditEntry } from '@Contexts/Settlements/Domain/Settlement/SettlementAudit';
import { SettlementMethod } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/**
 * A settlement the balances count, as a member reads it in their statement (feature 29, ADR 24): who paid whom how much, how it was
 * paid, and the instant the balances started to count it (`countedFrom`: when it was recorded in cash, when the provider said it
 * succeeded through the provider).
 */
export interface CountedSettlement {
  readonly settlementId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly method: SettlementMethod;
  readonly countedFrom: string;
}

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
   * The settlements of the group a member paid or received that the balances count (feature 29, ADR 24): the paid and the refunding ones
   * (a refunded one is not counted, and is not answered), each with when the balances started to count it, the oldest first. A
   * settlement is counted from its `settlement-paid` change, the one the audit writes in the transaction that counts it.
   */
  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]>;
  /**
   * The audit entries of the group's settlements, the oldest first (feature 28, ADR 23): each change of a settlement's money that Settlements
   * made, as it was written in the change's transaction. A group with none answers [].
   */
  auditOf(groupId: string): Promise<SettlementAuditEntry[]>;
}
