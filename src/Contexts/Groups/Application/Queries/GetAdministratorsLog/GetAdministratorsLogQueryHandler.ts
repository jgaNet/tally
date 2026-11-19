import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';
import { AdministratorLogEntry, IAdministratorLogReads } from '@Contexts/Groups/Application/Ports/IAdministratorLog';

/**
 * An administrator reads the administrators' log: every decision an administrator made about a settlement (Settlements', through
 * AdministratorDecisions) and every suspension and reinstatement of an account (Groups', request 34), the oldest first (request 33).
 */
export class GetAdministratorsLogQueryHandler extends QueryHandler<
  IAdministratorLogReads,
  void,
  IResult<AdministratorLogEntry[]>
> {
  /** Administrators only (request 33): a caller who is not signed in is asked to sign in (401); a signed-in one who is not an administrator finds nothing at this address (404), and nothing is read. */
  protected async guard(_: void, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId) return Result.fail(new NotAllowedException('Groups', 'Authentication required'));
    if (auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Groups', 'Not found'));
    return Result.ok();
  }

  async execute(_: void, __: ExecutionContext): Promise<IResult<AdministratorLogEntry[]>> {
    const [decisions, own] = await Promise.all([this.queries.decisions(), this.queries.entries()]);
    // Both are read oldest first; a stable sort by the moment keeps the settlements' decisions before a tie.
    return Result.ok([...decisions, ...own].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)));
  }
}
