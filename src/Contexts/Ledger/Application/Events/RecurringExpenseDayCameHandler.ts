import { IResult, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { EventHandler } from '@Architecture/Application/EventHandler';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseAmount } from '@Contexts/Ledger/Domain/Expense/ExpenseAmount';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { ExpenseDescription } from '@Contexts/Ledger/Domain/Expense/ExpenseDescription';
import { memberIdsOfSplit, Split } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpenseEvents';
import { auditEntryOf } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

import { IExpenseRepository } from '@Contexts/Ledger/Application/IExpenseRepository';
import { IAuditEntries } from '@Contexts/Ledger/Application/IAuditEntries';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';

/**
 * The policy that records the expense a day of a recurring expense became (request 23, ADR 20), in a transaction of its own: the expense
 * is made with the id the day was born with, carried by the fact, so that a fact handed out twice (a relay after a crash) finds the expense
 * recorded and records nothing more. It is split by the rule in force now, and recorded only while its payer and its split are members of
 * the group; the sweep has already checked that, and a member who left in between ends the day without an expense.
 */
export class RecurringExpenseDayCameHandler extends EventHandler<RecurringExpenseDayCameEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly audit: IAuditEntries,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute(event: RecurringExpenseDayCameEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const { expenseId, groupId, paidBy, description, amount, day, split, category } = event.payload;
    if (await this.expenses.get(expenseId)) return Result.ok(undefined);
    // A group archived since the sweep decided this day records nothing more (request 27): the day ends without an expense.
    if (await this.groupMembers.archivedOf(groupId)) return Result.ok(undefined);

    const members = await this.groupMembers.membersOf(groupId, paidBy);
    if (!members) return Result.ok(undefined);
    const memberIds = members.map(member => member.memberId);
    if (![paidBy, ...memberIdsOfSplit(split)].every(member => memberIds.includes(member))) return Result.ok(undefined);

    const expenseDescription = ExpenseDescription.create(description);
    if (expenseDescription.isFailure()) return expenseDescription;
    const expenseAmount = ExpenseAmount.create(amount);
    if (expenseAmount.isFailure()) return expenseAmount;
    const expenseDate = ExpenseDate.restore(day);
    if (expenseDate.isFailure()) return expenseDate;
    const shares = Split.create({ amount: expenseAmount.data, request: split, payer: paidBy });
    if (shares.isFailure()) return shares;

    const expense = Expense.register({
      id: expenseId,
      groupId,
      description: expenseDescription.data,
      amount: expenseAmount.data,
      original: undefined,
      date: expenseDate.data,
      split: shares.data,
      category,
    });
    await this.expenses.insert(expense, this.clock().toISOString());
    // The day's expense is a change of money its payer made (request 28), in the same transaction as the expense it records.
    await this.audit.add(
      groupId,
      auditEntryOf(
        { by: paidBy, action: 'expense-recorded', subjectId: expense._id.value, amount: expense.toSnapshot().amount },
        this.clock(),
      ),
    );
    await publishDomainEvents(expense, context);
    return Result.ok(undefined);
  }
}
