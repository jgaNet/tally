import { SharesOfMonth } from '@Contexts/Ledger/Domain/Insight/DTOs';

/** The read side of the spending insights: what a person's shares add up to, read at once (request 37, docs/adr/0037). */
export interface IInsightQueries {
  /**
   * The person's shares of the expenses of the given groups, summed per group, month and category, for the groups that have any. A
   * group not given, or an expense deleted, counts for nothing. Nothing is read when no group is given.
   */
  sharesOf(memberId: string, groupIds: string[]): Promise<SharesOfMonth[]>;
}
