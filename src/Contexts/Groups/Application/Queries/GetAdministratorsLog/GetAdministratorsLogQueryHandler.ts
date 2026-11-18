import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';
import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import {
  AdministratorDecision,
  IAdministratorDecisions,
} from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';

/**
 * An administrator reads the administrators' log, the oldest first (request 33): every decision an administrator made, as
 * Settlements wrote it. What only an administrator reads does not exist for anyone else.
 */
export class GetAdministratorsLogQueryHandler extends QueryHandler<
  IAdministratorDecisions,
  void,
  IResult<AdministratorDecision[]>
> {
  protected async guard(_: void, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId) return Result.fail(new NotAllowedException('Groups', 'Authentication required'));
    if (auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Groups', 'Not found'));
    return Result.ok();
  }

  async execute(): Promise<IResult<AdministratorDecision[]>> {
    return Result.ok(await this.queries.all());
  }
}
