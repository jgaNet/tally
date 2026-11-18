import { CountedSettlement, ISettledAmounts, SettledAmount } from '@Contexts/Ledger/Application/Ports/ISettledAmounts';
import { ISettledAmountsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';

/** Ledger's `ISettledAmounts`, answered over Settlements' read model, which the wiring of Settlements gives it when it is asked (ADR 4). */
export class SettledAmountsFromSettlements implements ISettledAmounts {
  constructor(private settlements: () => ISettledAmountsQueries) {}

  async settledOf(groupId: string): Promise<SettledAmount[]> {
    return this.settlements().settledOf(groupId);
  }

  async countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]> {
    return this.settlements().countedOf(groupId, memberId);
  }
}
