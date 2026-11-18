import { Id, IResult } from '@Architecture/Domain';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';

/** The budgets, stored by group and category. It answers the budget of a category, or null when there is none. */
export interface IBudgetRepository {
  findByCategory(groupId: Id, category: Category): Promise<Budget | null>;
  save(budget: Budget): Promise<IResult>;
}
