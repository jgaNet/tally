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
 * A signed-in member of a group reads the statement of any member of it, themselves included (request 8 and request 29): the expenses
 * and the settlements the balances count, in the order of a bank statement. For anyone who is not a member the group does not exist; for
 * a member's statement, one who has never been a member of the group does not exist. The statement is the one the CSV query renders.
 */
export class GetMemberStatementQueryHandler extends QueryHandler<
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
