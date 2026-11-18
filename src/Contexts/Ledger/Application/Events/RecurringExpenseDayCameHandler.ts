import { Clock, EventHandler, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { Result } from '@Architecture/Domain';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { listedMembers } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';

/**
 * Records the expense of a recurring expense's day (request 23, docs/adr/0022): the policy on `RecurringExpenseDayCame`, in a
 * transaction of its own. The expense is recorded with the id the fact carries, and only once: a fact that comes again finds the
 * expense recorded and records nothing. The split is the one given, computed by the rule in force now (request 10). Its members are
 * the ones the step checked to be current in the same transaction as the day, so they are the split's own. A group archived since the
 * step records nothing (request 27): the day is skipped here, as the step skipped it.
 */
export class RecurringExpenseDayCameHandler extends EventHandler<RecurringExpenseDayCameEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RecurringExpenseDayCameEvent, context: ExecutionContext) {
    if (await this.expenses.get(payload.expenseId)) return Result.ok(undefined);
    if (await this.groupMembers.isArchived(payload.groupId)) return Result.ok(undefined);

    const expense = Expense.register({
      id: payload.expenseId,
      groupId: payload.groupId,
      description: payload.description,
      amount: payload.amount,
      date: payload.date,
      paidBy: payload.paidBy,
      split: payload.split,
      category: payload.category,
      members: listedMembers(payload.split),
      archived: false,
      at: this.clock(),
    });
    if (expense.isFailure()) return expense;

    const saved = await this.expenses.save(expense.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(expense.data, context);
    return Result.ok(undefined);
  }
}
