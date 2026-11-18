import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { INettingQueries, NettingView } from '@Contexts/Settlements/Domain/Netting/Ports/INettingQueries';

/**
 * A netting is read by the two people in it, and by nobody else (request 32): to anyone else it does not exist. Its settlements are
 * in the order they were made.
 */
export class GetNettingQueryHandler extends QueryHandler<INettingQueries, { id: string }, IResult<NettingView>> {
  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<NettingView>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const reader = caller.data.value;

    const netting = await this.queries.findById(id);
    if (!netting || (netting.by !== reader && netting.with !== reader)) {
      return Result.fail(new NotFoundException('Settlements', 'Netting not found'));
    }
    return Result.ok(netting);
  }
}
