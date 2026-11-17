import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupBalances } from '@Contexts/Settlements/Application/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { TransferReadModel } from '@Contexts/Settlements/Application/ReadModel/TransferReadModel';
import { MemberBalance, suggestSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestSettlements';

/**
 * A member of a group reads the transfers that would bring every balance to 0, made by the algorithm of request 11 (see
 * `suggestSettlements`). Nothing is recorded: the balances are read as they are now, in the order the members joined. For
 * anyone who is not a member the group does not exist.
 */
export class GetSuggestedSettlementsQueryHandler extends QueryHandler<
  IGroupBalances,
  { groupId: string },
  IResult<TransferReadModel[]>
> {
  constructor(
    balances: IGroupBalances,
    private members: ISettlementMembers,
  ) {
    super(balances);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<TransferReadModel[]>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    if (!(await this.members.isMemberOf(groupId, caller.data.value))) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found', { id: groupId }));
    }

    const balances: MemberBalance[] = [];
    for (const memberId of await this.members.membersOf(groupId)) {
      balances.push({ memberId, balance: await this.queries.balanceOf(groupId, memberId) });
    }
    return Result.ok(suggestSettlements(balances));
  }
}
