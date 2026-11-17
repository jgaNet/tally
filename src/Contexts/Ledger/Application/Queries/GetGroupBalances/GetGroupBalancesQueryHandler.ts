import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IBalanceQueries } from '@Contexts/Ledger/Application/Ports/IBalanceQueries';
import { MemberBalanceReadModel } from '@Contexts/Ledger/Application/ReadModel/MemberBalanceReadModel';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/**
 * A signed-in member of a group reads every member's balance, in the order they joined, the earliest first; a member with
 * nothing recorded is at 0. For anyone who is not a member the group does not exist. The members come from Groups through
 * the port Ledger owns (ADR 3); the balances from the read model the expenses were counted into.
 */
export class GetGroupBalancesQueryHandler extends QueryHandler<
  IBalanceQueries,
  { groupId: string },
  IResult<MemberBalanceReadModel[]>
> {
  constructor(
    queries: IBalanceQueries,
    private groupMembers: IGroupMembers,
  ) {
    super(queries);
  }

  async execute(
    { groupId }: { groupId: string },
    context: ExecutionContext,
  ): Promise<IResult<MemberBalanceReadModel[]>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    if (!(await this.groupMembers.isMember(groupId, caller.data))) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: groupId }));
    }

    const recorded = new Map(
      (await this.queries.balancesOf(groupId)).map(balance => [balance.memberId, balance.balance] as const),
    );
    const members = await this.groupMembers.membersOf(groupId);
    return Result.ok(members.map(member => ({ memberId: member.value, balance: recorded.get(member.value) ?? 0 })));
  }
}
