import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IAdministratorLog } from '@Contexts/Groups/Application/Ports/IAdministratorLog';
import { ReinstateAccountCommandEvent } from '@Contexts/Groups/Application/Commands/ReinstateAccount/ReinstateAccountCommandEvent';

/**
 * An administrator reinstates an account (request 34, ADR 25): it starts what it started before, in any group,
 * and nothing in any group changes. Only an administrator reinstates; an account that is not suspended
 * changes nothing and is no entry of the administrators' log, which keeps the reinstatement in the transaction of its change.
 */
export class ReinstateAccountCommandHandler extends CommandHandler<ReinstateAccountCommandEvent> {
  constructor(
    private readonly accounts: IAccountRepository,
    private readonly log: IAdministratorLog,
    private readonly clock: Clock,
  ) {
    super();
  }

  /** Administrators only (request 34): a caller who is not one is refused before anything runs. */
  protected async guard(_: ReinstateAccountCommandEvent, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Groups', 'Only an administrator may do this'));
    }
    return Result.ok();
  }

  async execute({ payload }: ReinstateAccountCommandEvent, context: ExecutionContext): Promise<IResult> {
    const { subjectId } = context.auth;
    if (!subjectId) return Result.fail(new NotAllowedException('Groups', 'Authentication required'));

    const account = await this.accounts.findById(new Id(payload.accountId));
    if (!account) return Result.fail(new NotFoundException('Groups', 'Account not found'));

    const at = this.clock();
    if (!account.reinstate({ at })) return Result.ok();
    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return saved;
    await this.log.record({ at: at.toISOString(), by: subjectId, action: 'reinstated', subjectId: payload.accountId });
    await publishDomainEvents(account, context);
    return Result.ok();
  }
}
