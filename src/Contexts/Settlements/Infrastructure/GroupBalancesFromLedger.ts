import { IGroupBalances } from '@Contexts/Settlements/Application/Ports/IGroupBalances';
import { IMemberBalancesQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalancesQueries';

/**
 * Settlements' port to Ledger, answered over Ledger's balances read model (ADR 6): the integer Ledger keeps for the member,
 * read through the port Ledger publishes. The read model is a function, the one Ledger's wiring exports, because the wiring
 * files import one another (ADR 4): it is read when the balance is asked, not while the files are evaluated.
 */
export class GroupBalancesFromLedger implements IGroupBalances {
  constructor(private ledger: () => IMemberBalancesQueries) {}

  async balanceOf(groupId: string, memberId: string): Promise<number> {
    return this.ledger().balanceOf(groupId, memberId);
  }
}
