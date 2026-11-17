import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import {
  IStatementQueries,
  MemberStatement,
  StatementEntry,
} from '@Contexts/Ledger/Domain/Expense/Ports/IStatementQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member reads the statement of any member of their group, themselves included (request 8): the expenses the
 * member paid or is in the split of, in the order of a bank statement, each with the balance once it is counted, from 0.
 * The statement's balance is the last entry's, which is the balance the group's balances give the member. To anyone who
 * is not a member the group does not exist; a member the group has never had does not exist either. Membership is asked
 * of Groups, through the port.
 */
export class GetMemberStatementQueryHandler extends QueryHandler<
  IStatementQueries,
  { groupId: string; memberId: string },
  IResult<MemberStatement>
> {
  constructor(
    queries: IStatementQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute(
    { groupId, memberId }: { groupId: string; memberId: string },
    context: ExecutionContext,
  ): Promise<IResult<MemberStatement>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.groupMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    if (!members.some(member => member.memberId === memberId)) {
      return Result.fail(new NotFoundException('Ledger', 'Member not found'));
    }

    let balance = 0;
    const entries: StatementEntry[] = (await this.queries.rowsOf(groupId, memberId)).map(row => {
      balance += row.paid - row.share;
      return { ...row, balance };
    });
    return Result.ok({ memberId, balance, entries });
  }
}
