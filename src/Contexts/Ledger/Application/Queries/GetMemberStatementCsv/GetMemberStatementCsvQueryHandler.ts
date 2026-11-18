import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import { IStatementQueries } from '@Contexts/Ledger/Application/Ports/IStatementQueries';
import { StatementReadModel } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';
import { readMemberStatement } from '@Contexts/Ledger/Application/Queries/GetMemberStatement/GetMemberStatementQueryHandler';

/**
 * The statement of a member as the CSV route asks it: the same statement as GetMemberStatement reads (request 8, request 29),
 * read by the same function. The transport renders it as CSV (FastifyStatementController); this query does not render.
 */
export class GetMemberStatementCsvQueryHandler extends QueryHandler<
  IStatementQueries,
  { groupId: string; memberId: string },
  IResult<StatementReadModel>
> {
  constructor(
    queries: IStatementQueries,
    private readonly groupMembers: IGroupMembers,
    private readonly settled: ISettledAmounts,
  ) {
    super(queries);
  }

  async execute(
    { groupId, memberId }: { groupId: string; memberId: string },
    context: ExecutionContext,
  ): Promise<IResult<StatementReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;
    return readMemberStatement(
      { queries: this.queries, groupMembers: this.groupMembers, settled: this.settled },
      { groupId, memberId },
      caller.data,
    );
  }
}
