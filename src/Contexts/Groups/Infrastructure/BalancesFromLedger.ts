import { Id } from '@Architecture/Domain';

import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IMemberBalancesQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalancesQueries';

/**
 * Groups' port to Ledger, answered over Ledger's balances read model (ADR 4): the integer Ledger keeps for the member, read
 * through the port Ledger publishes. The read model is a function, the one Ledger's wiring exports, because the two wiring
 * files import each other: it is read when the balance is asked, not while the files are evaluated.
 */
export class BalancesFromLedger implements IMemberBalances {
  constructor(private ledger: () => IMemberBalancesQueries) {}

  async balanceOf(groupId: string, accountId: Id): Promise<number> {
    return this.ledger().balanceOf(groupId, accountId.value);
  }

  async allBalancesOf(groupId: string): Promise<number[]> {
    return this.ledger().allBalancesOf(groupId);
  }
}
