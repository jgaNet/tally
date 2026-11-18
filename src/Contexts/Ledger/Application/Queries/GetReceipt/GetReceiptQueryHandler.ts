import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { IReceiptQueries } from '@Contexts/Ledger/Application/Ports/IReceiptQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ReceiptReadModel } from '@Contexts/Ledger/Application/ReadModel/ReceiptReadModel';

/**
 * A member of the group reads the receipt of an expense: its type, its size and its link. For anyone who is not in the group
 * the expense does not exist; an expense with no receipt has none to read.
 */
export class GetReceiptQueryHandler extends QueryHandler<
  IReceiptQueries,
  { expenseId: string },
  IResult<ReceiptReadModel>
> {
  constructor(
    queries: IReceiptQueries,
    private readonly expenses: IExpenseQueries,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ expenseId }: { expenseId: string }, context: ExecutionContext): Promise<IResult<ReceiptReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const expense = await this.expenses.findById(expenseId);
    if (!expense) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));
    const role = await this.groupMembers.roleOf(new Id(expense.groupId), caller.data);
    if (role === null) return Result.fail(new NotFoundException('Ledger', 'Expense not found'));

    const receipt = await this.queries.findByExpense(expenseId);
    if (!receipt) return Result.fail(new NotFoundException('Ledger', 'Receipt not found'));
    return Result.ok(receipt);
  }
}
