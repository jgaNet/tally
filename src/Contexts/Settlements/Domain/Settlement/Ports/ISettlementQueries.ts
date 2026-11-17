import { SettledMember, SettlementWithHistory, WaitingMember } from '@Contexts/Settlements/Domain/Settlement/DTOs';

/** The read side of the settlements: what the queries answer, and what Ledger reads of what was settled (docs/adr/0013, docs/adr/0014). */
export interface ISettlementQueries {
  /** The settlement with its history, or undefined when there is no such settlement. */
  findSettlement(settlementId: string): Promise<SettlementWithHistory | undefined>;
  /**
   * Every settlement of the group with its history, the most recently recorded first (request 19). A group with no settlement answers an
   * empty list.
   */
  listSettlementsOf(groupId: string): Promise<SettlementWithHistory[]>;
  /**
   * What each member of the group paid and received in its settlements that count: the paid ones, and those refunding, one read; a member
   * who settled nothing is not listed. A pending, failed or refunded settlement is not here: the balances count a payment once it is paid,
   * until its money goes back (requests 13, 15).
   */
  settledOf(groupId: string): Promise<SettledMember[]>;
  /** What each member of the group is waiting to pay and to receive in its pending settlements, one read (request 13). */
  waitingOf(groupId: string): Promise<WaitingMember[]>;
  /**
   * Whether a settlement the member pays or receives through the provider, in the group, is pending or refunding: a member with one
   * may not leave the group (request 20, docs/adr/0019). Answered to Groups through its WaitingPayments port.
   */
  providerWaitingOf(groupId: string, memberId: string): Promise<boolean>;
}
