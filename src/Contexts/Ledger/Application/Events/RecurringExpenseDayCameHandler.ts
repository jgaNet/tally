import { IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';

/**
 * The policy on a recurring expense's day (request 23): the expense the day names is recorded, dated that day, paid by its payer,
 * with its description, amount and split, as an expense is recorded and split by the rule in force now (request 10). It is built on
 * the id the fact carries, so a fact delivered again finds the expense recorded and records nothing twice. It runs in a transaction of
 * its own; what it saves and records is published with it (EVENT-AFTER-COMMIT).
 */
export class RecurringExpenseDayCameHandler extends EventHandler<RecurringExpenseDayCameEvent> {
  constructor(
    private expenses: IExpenseRepository,
    private groupMembers: IGroupMembers,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RecurringExpenseDayCameEvent, context: ExecutionContext): Promise<IResult> {
    if (await this.expenses.findById(payload.expenseId)) return Result.ok();
    // An archived group records nothing, by the background job or by this policy (request 27).
    if (await this.groupMembers.isArchived(payload.groupId)) return Result.ok();

    const memberIds = await this.groupMembers.currentMemberIds(payload.groupId);
    const recorded = Expense.create({
      id: payload.expenseId,
      groupId: payload.groupId,
      description: payload.description,
      money: { amount: payload.amount },
      groupCurrency: payload.currency,
      date: payload.date,
      paidBy: payload.paidBy,
      split: payload.split,
      category: payload.category,
      members: memberIds,
      today: this.clock(),
    });
    if (recorded.isFailure()) return Result.fail(recorded.error);

    const saved = await this.expenses.save(recorded.data);
    if (saved.isFailure()) return Result.fail(saved.error);

    await publishDomainEvents(recorded.data, context);
    return Result.ok();
  }
}
