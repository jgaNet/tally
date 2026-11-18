import { IResult } from '@Architecture/Domain';
import { EventHandler, ExecutionContext } from '@Architecture/Application';

import { ExpenseEditedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseBudgetPolicy } from '@Contexts/Ledger/Application/Events/ExpenseBudgetPolicy';

/** The policy on an expense's edit: its month, in its category as it is now, is what the budget decides (request 24). */
export class ExpenseEditedBudgetHandler extends EventHandler<ExpenseEditedEvent> {
  constructor(private policy: ExpenseBudgetPolicy) {
    super();
  }

  execute({ payload }: ExpenseEditedEvent, context: ExecutionContext): Promise<IResult> {
    return this.policy.decide(payload.expenseId, context);
  }
}
