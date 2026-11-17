import { IGroupBalances } from '@Contexts/Settlements/Application/Ports/IGroupBalances';
import { IPendingPayments } from '@Contexts/Settlements/Application/Ports/IPendingPayments';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import {
  IOutstandingDebtsQueries,
  OutstandingDebt,
} from '@Contexts/Settlements/Domain/Settlement/Ports/IOutstandingDebtsQueries';

/**
 * What each current member of each group still owes (ADR 10): the balance Ledger counts, plus what is waiting at the provider, as
 * the suggestions count it (request 11). Only the members Groups says are current are read, so a former member owes nothing here.
 * Read outside any transaction: each balance is read as it is at the moment, and the sweep decides on what it reads.
 */
export class OutstandingDebtsReadModel implements IOutstandingDebtsQueries {
  constructor(
    private balances: IGroupBalances,
    private members: ISettlementMembers,
    private pending: IPendingPayments,
  ) {}

  async outstanding(): Promise<OutstandingDebt[]> {
    const debts: OutstandingDebt[] = [];
    for (const { groupId, memberIds } of await this.members.groupsWithMembers()) {
      const waiting = new Map((await this.pending.pendingEffectOf(groupId)).map(row => [row.memberId, row.amount]));
      for (const memberId of memberIds) {
        const balance = (await this.balances.balanceOf(groupId, memberId)) + (waiting.get(memberId) ?? 0);
        if (balance < 0) debts.push({ groupId, memberId, owed: -balance });
      }
    }
    return debts;
  }
}
