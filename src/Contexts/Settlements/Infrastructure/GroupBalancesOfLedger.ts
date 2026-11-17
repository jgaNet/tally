import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { MemberBalance } from '@Contexts/Settlements/Domain/Suggestion/DTOs';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Suggestion/Ports/IGroupBalances';

/**
 * Settlements' GroupBalances, answered over Ledger's read model (docs/adr/0012): the balances of a group as Ledger keeps them, read
 * when a suggestion is made. Translated here into Settlements' words: the account and a number, nothing else of a balance.
 */
export class GroupBalancesOfLedger implements IGroupBalances {
  constructor(private readonly expenses: IExpenseQueries) {}

  async groupIds(): Promise<string[]> {
    return this.expenses.groupIds();
  }

  async balancesOf(groupId: string): Promise<MemberBalance[]> {
    const balances = await this.expenses.balancesOf(groupId);
    return balances.map(({ memberId, balance }) => ({ memberId, balance }));
  }
}
