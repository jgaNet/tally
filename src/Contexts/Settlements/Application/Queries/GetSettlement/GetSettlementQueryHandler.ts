import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/**
 * A member of the group reads a settlement: its group, payer, payee, amount, how it was paid, its status and when it was
 * recorded. For anyone who is not a member of its group, the settlement does not exist.
 */
export class GetSettlementQueryHandler extends QueryHandler<
  ISettlementQueries,
  { id: string },
  IResult<SettlementReadModel>
> {
  constructor(
    settlements: ISettlementQueries,
    private readonly members: ISettlementMembers,
  ) {
    super(settlements);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<SettlementReadModel>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const settlement = await this.queries.findById(id);
    if (!settlement) return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));
    const members = await this.members.currentMembers(settlement.groupId);
    if (!members.includes(caller.data.value)) {
      return Result.fail(new NotFoundException('Settlements', 'Settlement not found'));
    }
    return Result.ok(settlement);
  }
}
