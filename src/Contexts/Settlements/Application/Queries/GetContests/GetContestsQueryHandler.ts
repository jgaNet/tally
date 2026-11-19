import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';

/** An administrator lists the settlements contested now, the earliest contested first, each as a member reads it (request 33). */
export class GetContestsQueryHandler extends QueryHandler<ISettlementQueries, void, IResult<SettlementReadModel[]>> {
  /** Administrators only (request 33): a caller who is not one is refused before anything runs. */
  /**
   * Administrators only (request 33): the list does not exist for anyone else. A caller who is not signed in is asked to sign
   * in (401); a signed-in one who is not an administrator finds nothing at this address (404), and nothing is read.
   */
  protected async guard(_: void, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId) return Result.fail(new NotAllowedException('Settlements', 'Authentication required'));
    if (auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Settlements', 'Not found'));
    return Result.ok();
  }

  async execute(_: void, __: ExecutionContext): Promise<IResult<SettlementReadModel[]>> {
    return Result.ok(await this.queries.findContested());
  }
}
