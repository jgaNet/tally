import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { StatementReadModel } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';
import {
  readMemberStatement,
  StatementSources,
} from '@Contexts/Ledger/Application/Queries/GetMemberStatement/MemberStatement';

/**
 * The statement of a member as the CSV route answers it (request 29): the same statement as request 8's query reads, the same
 * refusals, handed to the transport, which renders it as text/csv in the column order the API states. The rendering is the
 * transport's, so this query answers the statement itself and nothing about its format.
 */
export class GetMemberStatementCsvQueryHandler extends QueryHandler<
  IExpenseQueries,
  { groupId: string; memberId: string },
  IResult<StatementReadModel>
> {
  constructor(
    queries: IExpenseQueries,
    private sources: StatementSources,
  ) {
    super(queries);
  }

  async execute(
    { groupId, memberId }: { groupId: string; memberId: string },
    context: ExecutionContext,
  ): Promise<IResult<StatementReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    return readMemberStatement(this.queries, this.sources, groupId, memberId, caller.data);
  }
}
