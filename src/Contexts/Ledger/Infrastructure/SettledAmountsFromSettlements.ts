import { ISettledAmounts, SettledAmount } from '@Contexts/Ledger/Application/Ports/ISettledAmounts';
import { ISettledAmountsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettledAmountsQueries';

/**
 * Ledger's port to Settlements, answered over Settlements' read model (ADR 7): the change each member's settlements make to
 * their balance, read through the port Settlements publishes. The read model is a function, the one Settlements' wiring
 * exports, because the two wiring files import each other (ADR 4): it is read when the settled amounts are asked.
 */
export class SettledAmountsFromSettlements implements ISettledAmounts {
  constructor(private settlements: () => ISettledAmountsQueries) {}

  async settledOf(groupId: string): Promise<SettledAmount[]> {
    return this.settlements().settledOf(groupId);
  }
}
