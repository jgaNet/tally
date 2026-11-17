import { SettledMember, SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';

/** The read side of the settlements: what the queries answer, and what Ledger reads of what was settled (docs/adr/0013). */
export interface ISettlementQueries {
  /** The settlement, or undefined when there is no such settlement. */
  findSettlement(settlementId: string): Promise<SettlementView | undefined>;
  /** What each member of the group paid and received in its settlements, one read; a member who settled nothing is not listed. */
  settledOf(groupId: string): Promise<SettledMember[]>;
}
