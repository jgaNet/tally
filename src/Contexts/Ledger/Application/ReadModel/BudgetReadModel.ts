/** A budget as a member of its group reads it: its category, its amount in the group's currency, and what the current month spends in the category. */
export interface BudgetReadModel {
  category: string;
  amount: number;
  spent: number;
}
