import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { BalanceReadModel } from '@Contexts/Ledger/Application/ReadModel/BalanceReadModel';

/**
 * A member of the group reads every member's balance, in the order they joined, a member with nothing recorded at 0.
 * For anyone else the group does not exist, the same answer as for a group that was never created.
 */
export class GetGroupBalancesQueryHandler extends QueryHandler<
  IBalanceQueries,
  { id: string },
  IResult<BalanceReadModel[]>
> {
  constructor(
    queries: IBalanceQueries,
    private readonly groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<BalanceReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    // The balances are read before the members. A member who left had a balance of 0 (a member leaves only with 0, and an
    // expense that concerns a former member cannot change), so the members listed now cover every balance that is not 0,
    // and the list adds up to 0.
    const sums = await this.queries.sumsByMember(id);
    const members = await this.groupMembers.currentMembers(new Id(id));
    if (!members.some(member => member.equals(caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    }
    return Result.ok(members.map(member => ({ memberId: member.value, balance: sums.get(member.value) ?? 0 })));
  }
}
