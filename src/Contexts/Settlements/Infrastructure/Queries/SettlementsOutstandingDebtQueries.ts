import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import {
  IOutstandingDebtQueries,
  OutstandingDebt,
} from '@Contexts/Settlements/Domain/Settlement/Ports/IOutstandingDebtQueries';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { stillOwed } from '@Contexts/Settlements/Domain/Settlement/OutstandingDebts';

/**
 * What is still owed, for every current member of every group (ADR 10), answered over the read models: Groups' members (the
 * current ones, in the order they joined), Settlements' own port onto Ledger's balances (which count the paid settlements,
 * ADR 8), and the payments waiting at the provider. The arithmetic is `stillOwed`, in the domain.
 */
export class SettlementsOutstandingDebtQueries implements IOutstandingDebtQueries {
  constructor(
    private groups: IGroupQueries,
    private balances: IGroupBalances,
    private settlements: ISettlementQueries,
  ) {}

  async owing(): Promise<OutstandingDebt[]> {
    const membersByGroup = new Map<string, string[]>();
    for (const { groupId, memberId } of await this.groups.membersOfEveryGroup()) {
      membersByGroup.set(groupId, [...(membersByGroup.get(groupId) ?? []), memberId]);
    }

    const debts: OutstandingDebt[] = [];
    for (const [groupId, members] of membersByGroup) {
      const owed = stillOwed({
        members,
        balances: await this.balances.balancesOf(groupId),
        waiting: await this.settlements.waitingIn(groupId),
      });
      for (const { memberId, owes } of owed) debts.push({ groupId, memberId, owes });
    }
    return debts;
  }
}
