import { IResult, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IStatementQueries, MemberStatement } from '@Contexts/Ledger/Domain/Expense/Ports/IStatementQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { readMemberStatement } from '@Contexts/Ledger/Application/Queries/GetMemberStatement/readMemberStatement';

/**
 * The statement a member reads as CSV (request 29): the same statement as GetMemberStatement, answered to the route that
 * renders it as text/csv. The transport renders the rows; nothing here is rendered, and the refusals are the same.
 */
export class GetMemberStatementCsvQueryHandler extends QueryHandler<
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
