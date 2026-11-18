import { CommandEvent } from '@Architecture/Domain';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/** The payload of a budget removed: the group and the category, as the route names them. The remover is the caller. */
export interface RemoveBudgetPayload {
  groupId: string;
  category: Category;
}

export class RemoveBudgetCommandEvent extends CommandEvent<RemoveBudgetPayload> {}
