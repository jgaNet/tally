import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IMemberBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalanceSums';

/**
 * Groups' MemberBalances, answered over Ledger's balance read side (ADR 4). Groups' composition root gives it Ledger's
 * read for a command, so it reads inside the leave's transaction; Groups never reaches into Ledger's application.
 */
export class LedgerMemberBalances implements IMemberBalances {
  constructor(private readonly balances: IMemberBalanceSums) {}

  balanceOf(groupId: string, accountId: string): Promise<number> {
    return this.balances.balanceOf(groupId, accountId);
  }
}
