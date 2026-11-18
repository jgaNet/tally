import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense/RecordExpenseCommandEvent';

/**
 * Recording an expense: a signed-in member of a group records what they paid, split equally between members of the
 * group in the order given. The members who may be in the split are asked of Groups when this decides, and the group's
 * currency, which an expense paid in another currency is converted into; to anyone who is not a member the group does
 * not exist. The payer is the caller. The expense is saved and what it recorded is published with the save, in one
 * transaction. Its answer is the expense's id.
 */
export class RecordExpenseCommandHandler extends CommandHandler<RecordExpenseCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
    private expenses: IExpenseRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: RecordExpenseCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const payer = caller.data.value;

    const { groupId, description, money, date, split } = event.payload;
    const members = await this.groupMembers.membersOf(groupId, payer);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    const currency = await this.groupCurrency.currencyOf(groupId, payer);
    if (!currency) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    const recorded = Expense.create({
      groupId,
      description,
      money,
      groupCurrency: currency,
      date,
      paidBy: payer,
      split,
      members: members.map(member => member.memberId),
      today: this.clock(),
    });
    if (recorded.isFailure()) return Result.fail(recorded.error);
    const expense = recorded.data;

    const saved = await this.expenses.save(expense);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(expense, context);
    return Result.ok(expense._id.value);
  }
}
