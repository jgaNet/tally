import { IResult } from '@Architecture/Domain';
import { EventHandler, ExecutionContext } from '@Architecture/Application';

import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { ExpenseBudgetPolicy } from '@Contexts/Ledger/Application/Events/ExpenseBudgetPolicy';

/** The policy on an expense's recording: its month, in its category, is what the budget decides (request 24). */
export class ExpenseRecordedBudgetHandler extends EventHandler<ExpenseRecordedEvent> {
  constructor(private policy: ExpenseBudgetPolicy) {
    super();
  }

  execute({ payload }: ExpenseRecordedEvent, context: ExecutionContext): Promise<IResult> {
    return this.policy.decide(payload.expenseId, context);
  }
}
