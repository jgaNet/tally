import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense/RecordExpenseCommandEvent';

/**
 * A signed-in member of a group records an expense they paid: the payer is the caller, and the operation answers the
 * expense's id. For anyone who is not a member the group does not exist, the same refusal as one that is not there.
 * The split is decided by the expense; its members are read from Groups through the port Ledger owns (ADR 3). The
 * expense is counted into the balances in this same transaction, so the balances and the expense are stored together.
 */
export class RecordExpenseCommandHandler extends CommandHandler<RecordExpenseCommandEvent> {
  constructor(
    private expenses: IExpenseRepository,
    private groupMembers: IGroupMembers,
    private clock: Clock,
    private balances: IBalanceCounts,
  ) {
    super();
  }

  async execute({ payload }: RecordExpenseCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const members = await this.groupMembers.membersOf(payload.groupId);
    if (!members.some(member => member.value === caller.data.value)) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: payload.groupId }));
    }

    const expense = Expense.create({
      groupId: new Id(payload.groupId),
      paidBy: caller.data,
      description: payload.description,
      amount: payload.amount,
      date: payload.date,
      split: payload.split,
      groupMembers: members,
      now: this.clock(),
    });
    if (expense.isFailure()) return expense;

    const saved = await this.expenses.save(expense.data);
    if (saved.isFailure()) return saved;
    await this.balances.count(expense.data);

    await this.publishDomainEvents(expense.data, context);
    return Result.ok(expense.data._id.value);
  }
}
