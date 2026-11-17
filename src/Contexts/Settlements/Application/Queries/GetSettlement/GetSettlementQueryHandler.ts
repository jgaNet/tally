import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/**
 * A member of a settlement's group reads it. For anyone else it does not exist: the same answer as a settlement that is not
 * there, so that nobody learns from the refusal which settlements exist.
 */
export class GetSettlementQueryHandler extends QueryHandler<
  ISettlementQueries,
  { id: string },
  IResult<SettlementReadModel>
> {
  constructor(
    queries: ISettlementQueries,
    private members: ISettlementMembers,
  ) {
    super(queries);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<SettlementReadModel>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const settlement = await this.queries.findById(id);
    if (!settlement) return Result.fail(notFound(id));
    if (!(await this.members.isMemberOf(settlement.groupId, caller.data.value))) return Result.fail(notFound(id));
    return Result.ok(settlement);
  }
}

const notFound = (id: string) => new NotFoundException('Settlements', 'Settlement not found', { id });
