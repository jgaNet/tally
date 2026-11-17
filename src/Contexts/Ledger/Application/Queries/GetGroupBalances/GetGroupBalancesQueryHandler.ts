import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IBalanceQueries, MemberBalance } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceQueries';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member reads the balance of every member of their group, in the order they joined, the earliest first; a
 * member no expense counts has a balance of 0. To anyone who is not a member the group does not exist. The members and
 * their order are asked of Groups through the port; the sums are read from Ledger's own read model.
 */
export class GetGroupBalancesQueryHandler extends QueryHandler<
  IBalanceQueries,
  { groupId: string },
  IResult<MemberBalance[]>
> {
  constructor(
    queries: IBalanceQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<MemberBalance[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.groupMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    const counted = new Map(
      (await this.queries.balancesOf(groupId)).map(({ memberId, balance }) => [memberId, balance]),
    );
    return Result.ok(members.map(({ memberId }) => ({ memberId, balance: counted.get(memberId) ?? 0 })));
  }
}
