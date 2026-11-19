import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IAdministratorLog } from '@Contexts/Groups/Application/Ports/IAdministratorLog';
import { SuspendAccountCommandEvent } from '@Contexts/Groups/Application/Commands/SuspendAccount/SuspendAccountCommandEvent';

/**
 * An administrator suspends an account (request 34, ADR 25): nothing it starts that records money is accepted, in any group,
 * until it is reinstated, and nothing in any group changes. Only an administrator suspends; an account already suspended
 * changes nothing and is no entry of the administrators' log, which keeps the suspension in the transaction of its change.
 */
export class SuspendAccountCommandHandler extends CommandHandler<SuspendAccountCommandEvent> {
  constructor(
    private readonly accounts: IAccountRepository,
    private readonly log: IAdministratorLog,
    private readonly clock: Clock,
  ) {
    super();
  }

  /** Administrators only (request 34): a caller who is not one is refused before anything runs. */
  protected async guard(_: SuspendAccountCommandEvent, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Groups', 'Only an administrator may do this'));
    }
    return Result.ok();
  }

  async execute({ payload }: SuspendAccountCommandEvent, context: ExecutionContext): Promise<IResult> {
    const { subjectId } = context.auth;
    if (!subjectId) return Result.fail(new NotAllowedException('Groups', 'Authentication required'));

    const account = await this.accounts.findById(new Id(payload.accountId));
    if (!account) return Result.fail(new NotFoundException('Groups', 'Account not found'));

    const at = this.clock();
    if (!account.suspend({ at })) return Result.ok();
    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return saved;
    await this.log.record({ at: at.toISOString(), by: subjectId, action: 'suspended', subjectId: payload.accountId });
    await publishDomainEvents(account, context);
    return Result.ok();
  }
}
