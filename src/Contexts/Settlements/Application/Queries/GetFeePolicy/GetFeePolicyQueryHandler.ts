import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { FeePolicyReadModel } from '@Contexts/Settlements/Application/ReadModel/FeePolicyReadModel';

/** A member of a group reads who bears its provider's fee (request 38). For anyone who is not a member, the group does not exist. */
export class GetFeePolicyQueryHandler extends QueryHandler<
  ISettlementQueries,
  { groupId: string },
  IResult<FeePolicyReadModel>
> {
  constructor(
    settlements: ISettlementQueries,
    private readonly members: ISettlementMembers,
  ) {
    super(settlements);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<FeePolicyReadModel>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;
    const members = await this.members.currentMembers(groupId);
    if (!members.includes(caller.data.value)) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    }
    return Result.ok(await this.queries.findFeePolicy(groupId));
  }
}
