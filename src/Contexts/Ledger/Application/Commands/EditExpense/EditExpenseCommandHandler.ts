import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { EditExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/EditExpense/EditExpenseCommandEvent';
import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';

/**
 * A signed-in member of an expense's group edits it from the version they read. For anyone who is not a member the expense
 * does not exist. The edit is decided by the expense (its payer or the group's owner may edit it; it keeps its payer; it is
 * refused when it has changed since the version given). Its rate is settled against the rate the rates service offers for the
 * edit's day, asked through the port Ledger owns (ADR 13). The balances forget the expense as it was and count it as it now is,
 * in this same transaction, so the expense, its shares and its balances are stored together or not at all.
 */
export class EditExpenseCommandHandler extends CommandHandler<EditExpenseCommandEvent> {
  constructor(
    private expenses: IExpenseRepository,
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
    private offeredRates: IOfferedRates,
    private clock: Clock,
    private balances: IBalanceCounts,
  ) {
    super();
  }

  async execute({ payload }: EditExpenseCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const expense = await this.expenses.findById(new Id(payload.expenseId));
    if (!expense) return Result.fail(notFound(payload.expenseId));
    const role = await this.groupMembers.roleOf(expense.groupId.value, caller.data);
    if (!role) return Result.fail(notFound(payload.expenseId));
    const currency = await this.groupCurrency.currencyOf(expense.groupId.value);
    if (!currency) return Result.fail(notFound(payload.expenseId));

    const offer =
      'original' in payload.money
        ? await this.offeredRates.rateOn({ from: payload.money.original.currency, to: currency, date: payload.date })
        : null;

    const edited = expense.edit({
      by: caller.data,
      byOwner: role === 'owner',
      version: payload.version,
      description: payload.description,
      money: payload.money,
      date: payload.date,
      split: payload.split,
      category: payload.category,
      groupMembers: await this.groupMembers.membersOf(expense.groupId.value),
      groupCurrency: currency,
      offer,
      now: this.clock(),
    });
    if (edited.isFailure()) return edited;

    const saved = await this.expenses.save(edited.data);
    if (saved.isFailure()) return saved;
    await this.balances.uncount(expense);
    await this.balances.count(edited.data);

    await this.publishDomainEvents(edited.data, context);
    return Result.ok(expense._id.value);
  }
}

const notFound = (id: string) => new NotFoundException('Ledger', 'Expense not found', { id });
