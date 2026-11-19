import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotAllowedException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/** An administrator lists the settlements contested now, the earliest contested first, each as a member reads it (request 33). */
export class GetContestsQueryHandler extends QueryHandler<ISettlementQueries, void, IResult<SettlementReadModel[]>> {
  /** Administrators only (request 33): a caller who is not one is refused before anything runs. */
  protected async guard(_: void, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Settlements', 'Only an administrator may do this'));
    }
    return Result.ok();
  }

  async execute(_: void, __: ExecutionContext): Promise<IResult<SettlementReadModel[]>> {
    return Result.ok(await this.queries.findContested());
  }
}
