import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/**
 * A signed-in member of a group lists its settlements, each as it reads on its own (its history included): the most recently
 * recorded first, and on the same moment the one recorded last first. For anyone who is not a member the group does not exist.
 * A member who has left still reads the settlements of the group, which stay the group's after their payer or payee leaves.
 */
export class GetGroupSettlementsQueryHandler extends QueryHandler<
  ISettlementQueries,
  { groupId: string },
  IResult<SettlementReadModel[]>
> {
  constructor(
    queries: ISettlementQueries,
    private members: ISettlementMembers,
  ) {
    super(queries);
  }

  async execute({ groupId }: { groupId: string }, context: ExecutionContext): Promise<IResult<SettlementReadModel[]>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    if (!(await this.members.isMemberOf(groupId, caller.data.value))) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found', { id: groupId }));
    }

    // `ofGroup` answers the settlements in the order they were recorded, the earliest first: the position of one in it breaks a tie.
    const recorded = await this.queries.ofGroup(groupId);
    const latestFirst = recorded
      .map((settlement, order) => ({ settlement, order }))
      .sort((a, b) => compare(b.settlement.at, a.settlement.at) || b.order - a.order);
    return Result.ok(latestFirst.map(({ settlement }) => settlement));
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
