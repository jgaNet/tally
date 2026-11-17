import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { StatementEntryReadModel, StatementReadModel } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of a group reads the statement of any member of it, themselves included: every expense that has not been
 * deleted and that the member paid or is in the split of, the earliest date first and on the same date the earliest recorded
 * first. Each entry carries what the member paid, their share, and their running balance from 0. For anyone who is not a
 * member the group does not exist; for a member's statement, one who has never been a member of the group does not exist.
 * Nothing is stored per entry: the running balance is counted here, at the read, in the statement's order.
 */
export class GetMemberStatementQueryHandler extends QueryHandler<
  IExpenseQueries,
  { groupId: string; memberId: string },
  IResult<StatementReadModel>
> {
  constructor(
    queries: IExpenseQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute(
    { groupId, memberId }: { groupId: string; memberId: string },
    context: ExecutionContext,
  ): Promise<IResult<StatementReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    if (!(await this.groupMembers.isMember(groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
    }
    // A former member's statement is still read: a member who left is one the group has had (ADR 4).
    if (!(await this.groupMembers.hasBeenMember(groupId, new Id(memberId)))) {
      return Result.fail(new NotFoundException('Ledger', 'Member not found', { id: memberId }));
    }

    // Recorded order, the earliest first, so the index is the recording order the same-date sort reads.
    const recorded = await this.queries.ofGroup(groupId);
    const involved = recorded
      .map((expense, order) => ({ expense, order }))
      .filter(({ expense }) => involves(expense, memberId))
      .sort((a, b) => compare(a.expense.date, b.expense.date) || a.order - b.order);

    let balance = 0;
    const entries: StatementEntryReadModel[] = involved.map(({ expense }) => {
      const paid = expense.paidBy === memberId ? expense.amount : 0;
      const share = expense.shares.find(s => s.memberId === memberId)?.amount ?? 0;
      balance += paid - share;
      return { expenseId: expense.id, date: expense.date, description: expense.description, paid, share, balance };
    });
    return Result.ok({ memberId, balance, entries });
  }
}

const involves = (expense: ExpenseReadModel, memberId: string): boolean =>
  expense.paidBy === memberId || expense.shares.some(share => share.memberId === memberId);

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
