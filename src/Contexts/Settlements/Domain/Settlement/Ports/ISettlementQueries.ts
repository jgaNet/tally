import { SettledMember, SettlementView, WaitingMember } from '@Contexts/Settlements/Domain/Settlement/DTOs';

/** The read side of the settlements: what the queries answer, and what Ledger reads of what was settled (docs/adr/0013, docs/adr/0014). */
export interface ISettlementQueries {
  /** The settlement, or undefined when there is no such settlement. */
  findSettlement(settlementId: string): Promise<SettlementView | undefined>;
  /**
   * What each member of the group paid and received in its settlements that count: the paid ones, and those refunding, one read; a member
   * who settled nothing is not listed. A pending, failed or refunded settlement is not here: the balances count a payment once it is paid,
   * until its money goes back (requests 13, 15).
   */
  settledOf(groupId: string): Promise<SettledMember[]>;
  /** What each member of the group is waiting to pay and to receive in its pending settlements, one read (request 13). */
  waitingOf(groupId: string): Promise<WaitingMember[]>;
}
