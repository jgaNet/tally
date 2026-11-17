import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';

/**
 * Groups' MemberBalances, answered over Ledger's read model (docs/adr/0009): a member's balance in a group, read from
 * Ledger's own facts when a leave is decided. Translated here into Groups' words: the account and a number, nothing else.
 */
export class MemberBalancesOfLedger implements IMemberBalances {
  constructor(private readonly expenses: IExpenseQueries) {}

  async balanceOf(groupId: string, accountId: string): Promise<number> {
    const balances = await this.expenses.balancesOf(groupId);
    return balances.find(balance => balance.memberId === accountId)?.balance ?? 0;
  }
}
