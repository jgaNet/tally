import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { Transfer, suggestedSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

/**
 * A signed-in member reads the transfers that would bring every balance of their group to 0, in the order they are made
 * (request 11). It records nothing and changes nothing: the balances are what the expenses make them. To anyone who is not
 * a member the group does not exist. The members, in the order they joined, are asked of Groups through one port; the
 * balances are asked of Ledger through the other; the suggestion is the domain's rule applied to both.
 */
export class GetSuggestedSettlementsQueryHandler extends QueryHandler<
  IGroupBalances,
  { groupId: string },
  IResult<Transfer[]>
> {
  constructor(
    balances: IGroupBalances,
    private settlementMembers: ISettlementMembers,
  ) {
    super(balances);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<Transfer[]>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.settlementMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Group not found'));

    const counted = new Map(
      (await this.queries.balancesOf(groupId)).map(({ memberId, balance }) => [memberId, balance]),
    );
    const balances = members.map(({ memberId }) => ({ memberId, balance: counted.get(memberId) ?? 0 }));
    return Result.ok(suggestedSettlements(balances));
  }
}
