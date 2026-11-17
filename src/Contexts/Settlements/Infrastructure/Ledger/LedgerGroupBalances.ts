import { IBalanceQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceQueries';
import { GroupBalance, IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';

/**
 * Settlements' port onto Ledger, answered over Ledger's balances read model: each member's balance in a group, in
 * Settlements' own words (ADR 7). Ledger's read model is the one place balances are counted; this only translates it.
 */
export class LedgerGroupBalances implements IGroupBalances {
  constructor(private balances: IBalanceQueries) {}

  async balancesOf(groupId: string): Promise<GroupBalance[]> {
    return (await this.balances.balancesOf(groupId)).map(({ memberId, balance }) => ({ memberId, balance }));
  }
}
