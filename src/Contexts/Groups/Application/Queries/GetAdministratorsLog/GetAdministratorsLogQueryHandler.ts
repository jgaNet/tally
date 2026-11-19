import { IResult, NotAllowedException, Result } from '@Architecture/Domain';
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
  protected async guard(_: void, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Groups', 'Only an administrator may do this'));
    }
    return Result.ok();
  }

  async execute(_: void, __: ExecutionContext): Promise<IResult<AdministratorDecision[]>> {
    return Result.ok(await this.queries.decisions());
  }
}
