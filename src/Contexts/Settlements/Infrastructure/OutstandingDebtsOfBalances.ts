import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { IOutstandingDebtQueries, OutstandingDebt } from '@Contexts/Settlements/Domain/IOutstandingDebtQueries';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/ISettlementQueries';
import { stillOwed } from '@Contexts/Settlements/Domain/SettlementBook/StillOwed';

/**
 * What every current member of every group still owes (request 18, ADR 15): the balances the ledger reports, with the payments
 * waiting at the provider counted as paid, as the settlement rules and the suggestions count them, for the members Groups says
 * the groups have now. A balance is negative for what a member owes; it is answered as a positive amount.
 */
export class OutstandingDebtsOfBalances implements IOutstandingDebtQueries {
  constructor(
    private readonly members: Pick<ISettlementMembers, 'allMembers' | 'deletedOf'>,
    private readonly balances: IGroupBalances,
    private readonly settlements: Pick<ISettlementQueries, 'pendingOf'>,
  ) {}

  async outstandingDebts(): Promise<OutstandingDebt[]> {
    const debts: OutstandingDebt[] = [];
    for (const { groupId, memberIds, currency } of await this.members.allMembers()) {
      const owed = stillOwed(await this.balances.balancesOf(groupId), await this.settlements.pendingOf(groupId));
      for (const memberId of memberIds) {
        // A deleted member owes nothing that is reminded of (request 35): what is owed by them is not a debt Tally tells anyone about.
        if (await this.members.deletedOf(memberId)) continue;
        const balance = owed.get(memberId) ?? 0;
        if (balance < 0) debts.push({ groupId, memberId, currency, owed: -balance });
      }
    }
    return debts;
  }
}
