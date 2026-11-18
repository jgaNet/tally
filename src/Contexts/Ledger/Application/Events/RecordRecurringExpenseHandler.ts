import { Id, IResult, Result } from '@Architecture/Domain';
import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { GroupArchivedException } from '@SharedKernel/Domain';

import { IAuditLog } from '@Contexts/Ledger/Application/IAuditLog';
import { IExpenseStore } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupCurrency } from '@Contexts/Ledger/Application/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { expenseAuditId } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { GroupNotFoundException } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/**
 * Records the expense a day of a recurring expense stands for (request 23, ADR 18): the reaction to RecurringExpenseDayCame, which the
 * sweep records for each day that has come. The expense is built on the id the fact carries (DOMAIN-IDENTITY), dated the day, paid by the
 * payer, with the description, amount and split of the recurring expense, decided by the rule in force now and checked as a recording
 * is. An expense already recorded under that id is left as it is, so a redelivery records nothing twice. It runs in its own transaction:
 * the expense, its balances and its ExpenseRecorded commit together or not at all, as any expense's do; a refusal (a member who left
 * between the sweep and this reaction) records nothing, and the reaction fails with it. In an archived group (request 27) nothing is recorded:
 * the reaction fails with GroupArchived.
 */
export class RecordRecurringExpenseHandler extends EventHandler<RecurringExpenseDayCameEvent> {
  constructor(
    private readonly expenses: IExpenseStore,
    private readonly groupMembers: IGroupMembers,
    private readonly groupCurrency: IGroupCurrency,
    private readonly audit: IAuditLog,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: RecurringExpenseDayCameEvent, context: ExecutionContext): Promise<IResult<void>> {
    const { expenseId, groupId, paidBy, description, amount, day, split, category } = event.payload;
    if (await this.expenses.viewOf(expenseId)) return Result.ok(undefined);

    const members = await this.groupMembers.membersOf(groupId);
    const currency = await this.groupCurrency.currencyOf(groupId);
    if (!members || currency === undefined) return Result.fail(new GroupNotFoundException());
    const archived = await this.groupMembers.isArchived(groupId);
    if (archived) return Result.fail(new GroupArchivedException());
    const suspended = await this.groupMembers.isSuspended(paidBy);

    const now = this.clock();
    const recorded = Expense.register(
      { groupId, payerId: paidBy, groupCurrency: currency, description, date: day, amount, split, category },
      members.map(member => member.memberId),
      archived,
      suspended,
      now,
      new Id(expenseId),
    );
    if (recorded.isFailure()) return Result.fail(recorded.error);

    // The payer is the one the change acts for: the day is recorded for them, not by a member (request 28).
    await this.expenses.add(recorded.data);
    await this.audit.record({
      id: expenseAuditId.recorded(expenseId),
      groupId,
      at: now.toISOString(),
      by: paidBy,
      action: 'expense-recorded',
      subjectId: expenseId,
      amount,
    });
    await publishDomainEvents(recorded.data, context);
    return Result.ok(undefined);
  }
}
