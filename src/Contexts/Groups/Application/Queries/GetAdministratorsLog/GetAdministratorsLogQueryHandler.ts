import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';
import {
  IAdministratorDecisions,
  AdministratorDecision,
} from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';

/** An administrator reads the administrators' log: every decision an administrator made, the oldest first (request 33). */
export class GetAdministratorsLogQueryHandler extends QueryHandler<
  IAdministratorDecisions,
  void,
  IResult<AdministratorDecision[]>
> {
  /** Administrators only (request 33): a caller who is not one is refused before anything runs. */
  /**
   * Administrators only (request 33): the list does not exist for anyone else. A caller who is not signed in is asked to sign
   * in (401); a signed-in one who is not an administrator finds nothing at this address (404), and nothing is read.
   */
  protected async guard(_: void, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId) return Result.fail(new NotAllowedException('Groups', 'Authentication required'));
    if (auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Groups', 'Not found'));
    return Result.ok();
  }

  async execute(_: void, __: ExecutionContext): Promise<IResult<AdministratorDecision[]>> {
    return Result.ok(await this.queries.decisions());
  }
}
