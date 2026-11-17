import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { ISettlementEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementEffects';

/**
 * Ledger's SettledAmounts, answered over Settlements' read side (ADR 7): the read Settlements' wiring exports, which
 * Ledger's wiring hands it, for a query or for a command as the wiring says. Ledger imports only the read's Domain port.
 */
export class SettlementsSettledAmounts implements ISettledAmounts {
  constructor(private readonly settled: ISettlementEffects) {}

  settledByMember(groupId: string): Promise<Map<string, number>> {
    return this.settled.effectsOf(groupId);
  }
}
