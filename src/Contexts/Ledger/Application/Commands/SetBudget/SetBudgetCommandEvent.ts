import { CommandEvent } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** The payload of a budget set: the group and the category (as the route names them), and the amount. The setter is the caller. */
export interface SetBudgetPayload {
  groupId: string;
  category: Category;
  amount: number;
}

export class SetBudgetCommandEvent extends CommandEvent<SetBudgetPayload> {}
