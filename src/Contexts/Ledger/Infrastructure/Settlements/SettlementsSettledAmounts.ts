import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  CountedSettlement,
  ISettledAmounts,
  SettledAmount,
} from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';

/**
 * Ledger's port onto Settlements, answered over Settlements' read model (ADR 8): a settlement paid from one member to another
 * moves the payer's balance up by its amount and the payee's down by it, in Ledger's words.
 */
export class SettlementsSettledAmounts implements ISettledAmounts {
  constructor(private settlements: ISettlementQueries) {}

  async settledOf(groupId: string): Promise<SettledAmount[]> {
    const paid = await this.settlements.paidIn(groupId);
    return paid.flatMap(({ from, to, amount }) => [
      { memberId: from, amount },
      { memberId: to, amount: -amount },
    ]);
  }

  async countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]> {
    const counted = await this.settlements.countedIn(groupId);
    return counted
      .filter(({ from, to }) => from === memberId || to === memberId)
      .map(({ id, from, to, amount, method, countedAt }) => ({
        settlementId: id,
        from,
        to,
        amount,
        method,
        countedAt,
      }));
  }
}
