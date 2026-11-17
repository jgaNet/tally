import { IGroupBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupBalanceSums';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';

/**
 * Settlements' GroupBalances, answered over Ledger's balance read side (ADR 5). The composition root gives it Ledger's
 * read; Settlements never reaches into Ledger's application or infrastructure.
 */
export class LedgerGroupBalances implements IGroupBalances {
  constructor(private readonly sums: IGroupBalanceSums) {}

  balancesOf(groupId: string): Promise<Map<string, number>> {
    return this.sums.sumsByMember(groupId);
  }

  groupIds(): Promise<string[]> {
    return this.sums.groupIds();
  }
}
