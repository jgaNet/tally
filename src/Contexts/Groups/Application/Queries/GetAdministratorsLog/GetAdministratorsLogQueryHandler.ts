import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import {
  AdministratorDecision,
  IAdministratorDecisions,
} from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';

/**
 * The administrators' log, every decision an administrator made, the oldest first (request 33). Only an administrator reads it: nobody
 * signed in is asked to sign in, and for a signed-in caller who is not an administrator it does not exist.
 */
export class GetAdministratorsLogQueryHandler extends QueryHandler<
  IAdministratorDecisions,
  undefined,
  IResult<AdministratorDecision[]>
> {
  protected async guard(_: undefined, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId) return Result.fail(new NotAllowedException('Groups', 'Authentication required'));
    if (auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Groups', 'Not found'));
    return Result.ok();
  }

  async execute(_: undefined, __: ExecutionContext): Promise<IResult<AdministratorDecision[]>> {
    return Result.ok(await this.queries.entries());
  }
}
