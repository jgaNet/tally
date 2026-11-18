import { IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IStatementQueries, MemberStatement } from '@Contexts/Ledger/Domain/Expense/Ports/IStatementQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { readMemberStatement } from '@Contexts/Ledger/Application/Queries/GetMemberStatement/readMemberStatement';

/**
 * A signed-in member reads the statement of any member of their group, themselves included (requests 8, 29): the expenses and
 * the settlements the balances count, each with the balance once it is counted, from 0. The statement's balance is the last
 * entry's. It does not include the balances passed on when members left (request 20), which the group's balances count.
 */
export class GetMemberStatementQueryHandler extends QueryHandler<
  IStatementQueries,
  { groupId: string; memberId: string },
  IResult<MemberStatement>
> {
  constructor(
    queries: IStatementQueries,
    private groupMembers: IGroupMembers,
    private settledAmounts: ISettledAmounts,
  ) {
    super(queries);
  }

  async execute(
    { groupId, memberId }: { groupId: string; memberId: string },
    context: ExecutionContext,
  ): Promise<IResult<MemberStatement>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    return readMemberStatement(
      { statements: this.queries, groupMembers: this.groupMembers, settledAmounts: this.settledAmounts },
      { groupId, memberId },
      caller.data.value,
    );
  }
}
