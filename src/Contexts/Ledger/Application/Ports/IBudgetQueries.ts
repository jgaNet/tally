import { BudgetReadModel } from '@Contexts/Ledger/Application/ReadModel/BudgetReadModel';

export interface IBudgetQueries {
  /** The budgets of a group that limit their category, each with what `month` (`YYYY-MM`) spends in it. Empty for a group with none. */
  listByGroup(groupId: string, month: string): Promise<BudgetReadModel[]>;
}
