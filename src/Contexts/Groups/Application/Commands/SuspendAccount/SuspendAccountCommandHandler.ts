import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IGroupAdministratorLog } from '@Contexts/Groups/Application/Ports/IGroupAdministratorLog';
import { SuspendAccountCommandEvent } from '@Contexts/Groups/Application/Commands/SuspendAccount/SuspendAccountCommandEvent';

/**
 * An administrator suspends an account (request 34). Only an administrator may: the refusal is the operation's. The change is written in
 * the administrators' log in the same transaction, and an account already in that state is left as it is and logged nothing: one entry per change.
 */
export class SuspendAccountCommandHandler extends CommandHandler<SuspendAccountCommandEvent> {
  constructor(
    private accounts: IAccountRepository,
    private log: IGroupAdministratorLog,
    private clock: Clock,
  ) {
    super();
  }

  protected async guard(_: SuspendAccountCommandEvent, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Groups', 'Only an administrator may suspend an account'));
    }
    return Result.ok();
  }

  async execute({ payload }: SuspendAccountCommandEvent, context: ExecutionContext): Promise<IResult> {
    if (!context.auth.subjectId) return Result.fail(new NotAllowedException('Groups', 'Authentication required'));
    const administrator = new Id(context.auth.subjectId);

    const account = await this.accounts.findById(new Id(payload.accountId));
    if (!account) return Result.fail(new NotFoundException('Groups', 'Account not found', { id: payload.accountId }));

    const now = this.clock();
    if (!account.suspend(now)) return Result.ok();

    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return saved;
    await this.log.record({
      id: `suspended:${payload.accountId}:${now.toISOString()}`,
      at: now.toISOString(),
      by: administrator.value,
      action: 'suspended',
      subjectId: payload.accountId,
    });

    await this.publishDomainEvents(account, context);
    return Result.ok();
  }
}
