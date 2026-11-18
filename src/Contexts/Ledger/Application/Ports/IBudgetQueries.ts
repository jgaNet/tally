import { BudgetReadModel } from '@Contexts/Ledger/Application/ReadModel/BudgetReadModel';

export interface IBudgetQueries {
  /**
   * The budgets set for the group, one for each category that has one, in the order of the categories, each with what `month`
   * (YYYY-MM, in UTC) spends in it. Whoever asks: the handler decides whether the caller may read them.
   */
  ofGroup(groupId: string, month: string): Promise<BudgetReadModel[]>;
}
