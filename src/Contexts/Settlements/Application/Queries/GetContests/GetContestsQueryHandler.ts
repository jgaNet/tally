import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { ISettlementQueries, SettlementView } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/**
 * An administrator lists the settlements contested now, the earliest contested first, each as a member reads it (request 33). What
 * only an administrator reads does not exist for anyone else.
 */
export class GetContestsQueryHandler extends QueryHandler<ISettlementQueries, void, IResult<SettlementView[]>> {
  protected async guard(_: void, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId) return Result.fail(new NotAllowedException('Settlements', 'Authentication required'));
    if (auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Settlements', 'Not found'));
    return Result.ok();
  }

  async execute(): Promise<IResult<SettlementView[]>> {
    return Result.ok(await this.queries.contested());
  }
}
