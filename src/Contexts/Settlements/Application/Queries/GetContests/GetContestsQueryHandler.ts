import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/**
 * The settlements contested now, the earliest contested first, each as it reads on its own (request 33). Only an administrator reads
 * them: nobody signed in is asked to sign in, and for a signed-in caller who is not an administrator they do not exist.
 */
export class GetContestsQueryHandler extends QueryHandler<
  ISettlementQueries,
  undefined,
  IResult<SettlementReadModel[]>
> {
  protected async guard(_: undefined, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId) return Result.fail(new NotAllowedException('Settlements', 'Authentication required'));
    if (auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Settlements', 'Not found'));
    return Result.ok();
  }

  async execute(_: undefined, __: ExecutionContext): Promise<IResult<SettlementReadModel[]>> {
    return Result.ok(await this.queries.contested());
  }
}
