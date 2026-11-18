import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IReceiptQueries, ReceiptView } from '@Contexts/Ledger/Domain/Receipt/Ports/IReceiptQueries';

/**
 * A signed-in member of an expense's group reads its receipt: its type, its size, and the link the store keeps it at (request 26).
 * To anyone who is not a member the expense does not exist; an expense with no receipt has none to read, as `404`.
 */
export class GetReceiptQueryHandler extends QueryHandler<IReceiptQueries, { expenseId: string }, IResult<ReceiptView>> {
  constructor(
    queries: IReceiptQueries,
    private expenses: IExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ expenseId }: { expenseId: string }, context: ExecutionContext): Promise<IResult<ReceiptView>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const expense = await this.expenses.findExpense(expenseId);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Receipt not found'));
    const members = await this.groupMembers.membersOf(expense.groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Receipt not found'));

    const receipt = await this.queries.findByExpense(expenseId);
    if (!receipt) return Result.fail(new NotFoundException('Ledger', 'The expense has no receipt'));

    return Result.ok(receipt);
  }
}
