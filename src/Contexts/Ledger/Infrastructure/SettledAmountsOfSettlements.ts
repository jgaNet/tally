import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  CountedSettlement,
  ISettledAmounts,
  SettledAmount,
} from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';

/**
 * Ledger's SettledAmounts, answered over Settlements' read model (docs/adr/0013): what each member paid and received in the
 * settlements of a group, read when a balance is read. Translated here into Ledger's words: the account and one amount.
 */
export class SettledAmountsOfSettlements implements ISettledAmounts {
  constructor(private readonly settlements: ISettlementQueries) {}

  async settledOf(groupId: string): Promise<SettledAmount[]> {
    const settled = await this.settlements.settledOf(groupId);
    return settled.map(({ memberId, paid, received }) => ({ memberId, amount: paid - received }));
  }

  async countedOf(groupId: string): Promise<CountedSettlement[]> {
    const counted = await this.settlements.countedOf(groupId);
    return counted.map(({ settlementId, payerId, payeeId, amount, method, countedFrom }) => ({
      settlementId,
      payerId,
      payeeId,
      amount,
      method,
      countedFrom,
    }));
  }
}
