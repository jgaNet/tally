import { CountedSettlement, ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { ISettlementEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementEffects';
import { ICountedSettlements } from '@Contexts/Settlements/Domain/Settlement/Ports/ICountedSettlements';

/**
 * Ledger's SettledAmounts, answered over Settlements' read side (ADR 7): the reads Settlements' wiring exports, which
 * Ledger's wiring hands it, for a query or for a command as the wiring says. Ledger imports only the reads' Domain ports.
 */
export class SettlementsSettledAmounts implements ISettledAmounts {
  constructor(
    private readonly settled: ISettlementEffects,
    private readonly counted: ICountedSettlements,
  ) {}

  settledByMember(groupId: string): Promise<Map<string, number>> {
    return this.settled.effectsOf(groupId);
  }

  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]> {
    return this.counted.countedOf(groupId, memberId);
  }
}
