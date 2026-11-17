import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { Transfer, suggestedSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestedSettlements';

/**
 * A signed-in member reads the transfers that would bring every balance of their group to 0, in the order they are made
 * (request 11, counted as request 13 says: a payment waiting at the provider counts as if paid). It records nothing and changes
 * nothing: the balances are what the expenses and the paid settlements make them, less the payments waiting. To anyone who is not
 * a member the group does not exist. The members are asked of Groups through one port; the balances are asked of Ledger through
 * the other; the waiting payments are read from Settlements' own read model; the suggestion is the domain's rule applied to all.
 */
export class GetSuggestedSettlementsQueryHandler extends QueryHandler<
  IGroupBalances,
  { groupId: string },
  IResult<Transfer[]>
> {
  constructor(
    balances: IGroupBalances,
    private settlementMembers: ISettlementMembers,
    private settlements: ISettlementQueries,
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
    // A payment waiting at the provider counts as paid: the payer owes that much less, the payee is owed that much less.
    for (const { from, to, amount } of await this.settlements.waitingIn(groupId)) {
      counted.set(from, (counted.get(from) ?? 0) + amount);
      counted.set(to, (counted.get(to) ?? 0) - amount);
    }
    const balances = members.map(({ memberId }) => ({ memberId, balance: counted.get(memberId) ?? 0 }));
    return Result.ok(suggestedSettlements(balances));
  }
}
