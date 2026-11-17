import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IStatementQueries } from '@Contexts/Ledger/Application/Ports/IStatementQueries';
import { StatementReadModel } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';

/**
 * A member of the group reads the statement of any member of the group, a former one included, themselves included: the
 * expenses the member paid or is in the split of, the earliest first, each with the balance once it is counted, from 0.
 * For anyone else the group does not exist; a statement of an account that has never been a member of the group does
 * not exist either.
 */
export class GetMemberStatementQueryHandler extends QueryHandler<
  IStatementQueries,
  { groupId: string; memberId: string },
  IResult<StatementReadModel>
> {
  constructor(
    queries: IStatementQueries,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute(
    { groupId, memberId }: { groupId: string; memberId: string },
    context: ExecutionContext,
  ): Promise<IResult<StatementReadModel>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    // The lines are read before the members, as the balances are (GetGroupBalances).
    const lines = await this.queries.entriesOf(groupId, memberId);
    const members = await this.groupMembers.currentMembers(new Id(groupId));
    if (!members.some(member => member.equals(caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    }
    if (!(await this.groupMembers.hasBeenMember(new Id(groupId), new Id(memberId)))) {
      return Result.fail(new NotFoundException('Ledger', 'Member not found'));
    }

    // The balance is counted here, in the statement's order: nothing is stored per entry.
    let balance = 0;
    const entries = lines.map(line => {
      balance += line.paid - line.share;
      return { ...line, balance };
    });
    return Result.ok({ memberId, balance, entries });
  }
}
