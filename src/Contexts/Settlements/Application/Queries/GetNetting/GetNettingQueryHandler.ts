import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { INettingQueries } from '@Contexts/Settlements/Application/Ports/INettingQueries';
import { NettingReadModel } from '@Contexts/Settlements/Application/ReadModel/NettingReadModel';

/**
 * One of the two people reads a netting: who asked, with whom, its currency, the amount netted, and its settlements in the
 * order they were made (request 32). For anyone else the netting does not exist.
 */
export class GetNettingQueryHandler extends QueryHandler<INettingQueries, { id: string }, IResult<NettingReadModel>> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<NettingReadModel>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const netting = await this.queries.findById(id);
    const isOneOfThem = netting !== null && (netting.by === caller.data.value || netting.with === caller.data.value);
    if (!netting || !isOneOfThem) return Result.fail(new NotFoundException('Settlements', 'Netting not found'));
    return Result.ok(netting);
  }
}
