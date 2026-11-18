import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IOfferedRates, offerForExpense } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { EditExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/EditExpense/EditExpenseCommandEvent';

/**
 * Editing an expense: a signed-in member who is its payer or the group's owner gives it again, whole, from the version
 * they read. To anyone who is not a member of its group the expense does not exist; the group's currency is asked of
 * Groups beside its members, as recording asks it, and an expense in another currency is given the rate offered for its
 * currency and day when its rate is left out (request 22). The edit is decided on the expense
 * as it is stored when this runs: when another edit got there first, the store refuses this one with a conflict and the
 * command runs again from a fresh read, where the version refuses it by name. The edited expense is saved and what it
 * recorded is published with the save, in one transaction. Its answer is the expense's id.
 */
export class EditExpenseCommandHandler extends CommandHandler<EditExpenseCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
    private offeredRates: IOfferedRates,
    private expenses: IExpenseRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: EditExpenseCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const editor = caller.data.value;

    const { expenseId, description, money, date, split, version, category } = event.payload;
    const expense = await this.expenses.findById(expenseId);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const members = await this.groupMembers.membersOf(expense.groupId, editor);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const currency = await this.groupCurrency.currencyOf(expense.groupId, editor);
    if (!currency) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));

    const today = this.clock();
    const offer = await offerForExpense(this.offeredRates, money, currency, date, today);
    const edited = expense.edit({
      editedBy: editor,
      members,
      groupCurrency: currency,
      version,
      description,
      money,
      date,
      split,
      today,
      offer,
      category,
    });
    if (edited.isFailure()) return Result.fail(edited.error);

    const saved = await this.expenses.save(edited.data);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(edited.data, context);
    return Result.ok(expenseId);
  }
}
