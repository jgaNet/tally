import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';

/** A budget as a member reads it: its category, its amount a month, and what the current month spends in the category (request 24). */
export interface BudgetReadModel {
  category: CategoryName;
  amount: number;
  spent: number;
}
