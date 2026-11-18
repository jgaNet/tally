import { Clock, EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { Amount } from '@Contexts/Ledger/Domain/Expense/Amount';
import { Description } from '@Contexts/Ledger/Domain/Expense/Description';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ExpenseDate } from '@Contexts/Ledger/Domain/Expense/ExpenseDate';
import { Split } from '@Contexts/Ledger/Domain/Expense/Split';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';

/**
 * The expense of a recurring expense's day is recorded (request 23, ADR 16): dated that day, paid by its payer, with its
 * description, amount and split as the recurring expense gave them, under the identity the day was given. The reaction runs
 * in a transaction of its own; a fact delivered again finds its expense recorded and records nothing a second time.
 */
export class RecurringExpenseDayCameEventHandler extends EventHandler<RecurringExpenseDayCameEvent> {
  constructor(
    private readonly expenses: IExpenseRepository,
    private readonly groupMembers: IGroupMembers,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RecurringExpenseDayCameEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const expenseId = new Id(payload.expenseId);
    if ((await this.expenses.findById(expenseId)) !== null) return Result.ok();

    const groupId = new Id(payload.groupId);
    const payer = new Id(payload.paidBy);
    const description = Description.create(payload.description);
    if (description.isFailure()) return description;
    const amount = Amount.create(payload.amount);
    if (amount.isFailure()) return amount;
    const date = ExpenseDate.parse(payload.day);
    if (date.isFailure()) return date;
    const split = Split.fromRequest({ amount: amount.data, payer, request: payload.splitRequest });
    if (split.isFailure()) return split;

    const expense = Expense.create({
      id: expenseId,
      groupId,
      description: description.data,
      amount: amount.data,
      date: date.data,
      split: split.data,
      groupMembers: await this.groupMembers.currentMembers(groupId),
      at: this.clock(),
    });
    if (expense.isFailure()) return expense;

    const saved = await this.expenses.save(expense.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(expense.data, context);
    return Result.ok();
  }
}
