import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { IReceiptQueries } from '@Contexts/Ledger/Application/Ports/IReceiptQueries';
import { ReceiptReadModel } from '@Contexts/Ledger/Application/ReadModel/ReceiptReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of an expense's group reads its receipt: its type, its size and the store's link. For anyone who is not a member, or
 * for an expense that does not exist (or has been deleted), the receipt does not exist; neither does one the expense has not got.
 */
export class GetReceiptQueryHandler extends QueryHandler<
  IReceiptQueries,
  { expenseId: string },
  IResult<ReceiptReadModel>
> {
  constructor(
    queries: IReceiptQueries,
    private expenses: IExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ expenseId }: { expenseId: string }, context: ExecutionContext): Promise<IResult<ReceiptReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const expense = await this.expenses.findById(expenseId);
    if (!expense || !(await this.groupMembers.isMember(expense.groupId, caller.data))) {
      return Result.fail(notFound(expenseId));
    }
    const receipt = await this.queries.findByExpense(expenseId);
    if (!receipt) return Result.fail(notFound(expenseId));
    return Result.ok(receipt);
  }
}

const notFound = (expenseId: string) => new NotFoundException('Ledger', 'Receipt not found', { expenseId });
