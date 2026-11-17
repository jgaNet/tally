import { IBalanceQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceQueries';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';

/**
 * Groups' port onto Ledger, answered over Ledger's balances read model: the balance of one member of a group, as the
 * Ledger counts it. Groups' own words for it are the port's; the read model is Ledger's (ADR 5).
 */
export class LedgerBalances implements IMemberBalances {
  constructor(private balances: IBalanceQueries) {}

  async balanceOf(groupId: string, memberId: string): Promise<number> {
    const counted = await this.balances.balancesOf(groupId);
    return counted.find(member => member.memberId === memberId)?.balance ?? 0;
  }
}
