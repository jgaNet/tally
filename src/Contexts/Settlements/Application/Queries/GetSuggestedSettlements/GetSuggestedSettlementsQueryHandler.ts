import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupBalances } from '@Contexts/Settlements/Application/Ports/IGroupBalances';
import { IPendingPayments } from '@Contexts/Settlements/Application/Ports/IPendingPayments';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { TransferReadModel } from '@Contexts/Settlements/Application/ReadModel/TransferReadModel';
import { MemberBalance, suggestSettlements } from '@Contexts/Settlements/Domain/Settlement/SuggestSettlements';

/**
 * A member of a group reads the transfers that would bring every balance to 0, made by the algorithm of request 11 (see
 * `suggestSettlements`). A payment waiting at the provider counts as if it were paid (request 13), so each balance is the balance
 * Ledger counts, plus what is waiting. Nothing is recorded. For anyone who is not a member the group does not exist.
 */
export class GetSuggestedSettlementsQueryHandler extends QueryHandler<
  IGroupBalances,
  { groupId: string },
  IResult<TransferReadModel[]>
> {
  constructor(
    balances: IGroupBalances,
    private members: ISettlementMembers,
    private pending: IPendingPayments,
  ) {
    super(balances);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<TransferReadModel[]>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    if (!(await this.members.isMemberOf(groupId, caller.data.value))) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found', { id: groupId }));
    }

    const waiting = new Map((await this.pending.pendingEffectOf(groupId)).map(row => [row.memberId, row.amount]));
    const balances: MemberBalance[] = [];
    for (const memberId of await this.members.membersOf(groupId)) {
      const balance = await this.queries.balanceOf(groupId, memberId);
      balances.push({ memberId, balance: balance + (waiting.get(memberId) ?? 0) });
    }
    return Result.ok(suggestSettlements(balances));
  }
}
