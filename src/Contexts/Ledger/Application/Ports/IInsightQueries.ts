import { GroupShareReadModel } from '@Contexts/Ledger/Application/ReadModel/InsightReadModel';

export interface IInsightQueries {
  /**
   * The shares of the account in the expenses of these groups, summed by group, month (`YYYY-MM`, UTC) and category: a deleted
   * expense counts for nothing, and a group with no share of the account has no line. Empty when there is no group.
   */
  sharesOf(accountId: string, groupIds: string[]): Promise<GroupShareReadModel[]>;
}
