import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';

/** A member's share of one group's expenses in one month and category (request 37), in the group's currency, summed by the read model. */
export interface GroupSpending {
  groupId: string;
  month: string;
  category: CategoryName;
  amount: number;
}

/**
 * What a member's shares add up to, by group, month and category (request 37): the sum of their shares in the expenses of the groups
 * given, dated in the month (YYYY-MM, in UTC). The deleted expenses are gone from the table, so they count for nothing. Whoever asks:
 * the query decides for whom, and passes only the member's own id.
 */
export interface ISpendingQueries {
  sharesOf(memberId: string, groupIds: string[]): Promise<GroupSpending[]>;
}
