import { stillBalance } from '@Contexts/Settlements/Domain/Settlement/StillOwed';
import { OutstandingDebt } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { IOutstandingDebtQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IOutstandingDebtQueries';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Suggestion/Ports/IGroupBalances';

/**
 * Settlements' what-is-still-owed, read over Ledger's balances (through its own GroupBalances port) and Settlements' read model
 * (docs/adr/0018): for each group, each member's balance once the payments waiting on it count as paid (`stillBalance`). A member
 * who leaves a group has left at a balance of 0 (docs/adr/0009), so no former member is listed as owing.
 */
export class OutstandingDebtsOfLedger implements IOutstandingDebtQueries {
  constructor(
    private readonly balances: IGroupBalances,
    private readonly settlements: ISettlementQueries,
  ) {}

  async outstandingDebts(): Promise<OutstandingDebt[]> {
    const debts: OutstandingDebt[] = [];
    for (const groupId of await this.balances.groupIds()) {
      const waiting = await this.settlements.waitingOf(groupId);
      for (const { memberId, balance } of await this.balances.balancesOf(groupId)) {
        const pending = waiting.find(member => member.memberId === memberId) ?? { memberId, paid: 0, received: 0 };
        const still = stillBalance(balance, pending);
        if (still < 0) debts.push({ groupId, memberId, amount: -still });
      }
    }
    return debts;
  }
}
