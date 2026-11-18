import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { FeeBorne } from '@Contexts/Settlements/Domain/Settlement/Settlement';

/**
 * A member of a group reads who bears the provider's fee of its payments (request 38). For anyone who is not a member the group does not
 * exist: the same answer as a group that is not there.
 */
export class GetFeePolicyQueryHandler extends QueryHandler<
  ISettlementQueries,
  { groupId: string },
  IResult<{ borneBy: FeeBorne }>
> {
  constructor(
    queries: ISettlementQueries,
    private members: ISettlementMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<{ borneBy: FeeBorne }>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    if (!(await this.members.isMemberOf(groupId, caller.data.value))) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found', { id: groupId }));
    }
    return Result.ok({ borneBy: await this.queries.feePolicyOf(groupId) });
  }
}
