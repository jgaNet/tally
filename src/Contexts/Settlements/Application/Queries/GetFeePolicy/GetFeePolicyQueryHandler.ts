import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { FeeBorneBy } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/**
 * A member of a group reads who bears its provider's fee (request 38): payer, payee or shared, the payee until the owner decides.
 * To anyone who is not a member the group does not exist.
 */
export class GetFeePolicyQueryHandler extends QueryHandler<
  ISettlementQueries,
  { groupId: string },
  IResult<{ borneBy: FeeBorneBy }>
> {
  constructor(
    queries: ISettlementQueries,
    private settlementMembers: ISettlementMembers,
  ) {
    super(queries);
  }

  async execute(
    { groupId }: { groupId: string },
    context: ExecutionContext,
  ): Promise<IResult<{ borneBy: FeeBorneBy }>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);

    const members = await this.settlementMembers.membersOf(groupId, caller.data.value);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    return Result.ok({ borneBy: await this.queries.feePolicyOf(groupId) });
  }
}
