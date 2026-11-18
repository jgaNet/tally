import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { CONFLICT_ATTEMPTS } from '@Architecture/Application/Lite/UseCase';

import { IBudgetStore } from '@Contexts/Ledger/Application/IBudgetStore';
import { IExpenseStore } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { ExpenseEditedEvent, ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Expense';
import { monthOfDay } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * Judges the month of a recorded or edited expense against its category's budget (request 24, ADR 19): the reaction to ExpenseRecorded and
 * to ExpenseEdited. It reads what the expense's month spends in its category (the committed expenses, the deleted ones left out), and the
 * members to tell (through GroupMembers), and asks the budget whether the month passes it: the budget records BudgetPassed once for the month,
 * and a month that already passed records nothing. It runs in its own transaction; a budget changed by another server since it was read is
 * read again and judged again, up to CONFLICT_ATTEMPTS times (CONC-OPTIMISTIC).
 */
export class PassBudgetHandler extends EventHandler<ExpenseRecordedEvent | ExpenseEditedEvent> {
  constructor(
    private readonly budgets: IBudgetStore,
    private readonly expenses: IExpenseStore,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: ExpenseRecordedEvent | ExpenseEditedEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { groupId, category, date } = event.payload;
    const month = monthOfDay(date);
    for (let attempt = 1; ; attempt++) {
      const budget = await this.budgets.findByCategory(groupId, category);
      if (!budget || budget.amount === undefined) return Result.ok(undefined);

      const spent = await this.expenses.spentIn(groupId, category, month);
      const members = await this.groupMembers.membersOf(groupId);
      if (!members) return Result.ok(undefined);

      const passed = budget.judge(
        month,
        spent,
        members.map(member => member.memberId),
        this.clock(),
      );
      if (!passed) return Result.ok(undefined);
      try {
        await this.budgets.save(budget);
      } catch (error) {
        if (error instanceof ConcurrencyConflictException && attempt < CONFLICT_ATTEMPTS) continue;
        throw error;
      }
      await publishDomainEvents(budget, context);
      return Result.ok(undefined);
    }
  }
}
