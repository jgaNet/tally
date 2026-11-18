import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { INettingQueries } from '@Contexts/Settlements/Application/Ports/INettingQueries';
import { NettingReadModel } from '@Contexts/Settlements/Application/ReadModel/NettingReadModel';

/**
 * One of the two people reads a netting (request 32). For anyone else it does not exist: the same answer as a netting that is not
 * there, so that nobody learns from the refusal which nettings exist.
 */
export class GetNettingQueryHandler extends QueryHandler<INettingQueries, { id: string }, IResult<NettingReadModel>> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<NettingReadModel>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const netting = await this.queries.findById(id);
    if (!netting) return Result.fail(notFound(id));
    if (caller.data.value !== netting.by && caller.data.value !== netting.with) return Result.fail(notFound(id));
    return Result.ok(netting);
  }
}

const notFound = (id: string) => new NotFoundException('Settlements', 'Netting not found', { id });
