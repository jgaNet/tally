import { IResult, NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Role } from '@SharedKernel/Domain';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { IAdministratorsLog } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorsLog';
import { administratorsLogEntry } from '@Contexts/Groups/Domain/Account/AdministratorsLogEntry';
import { SuspendAccountCommandEvent } from '@Contexts/Groups/Application/Commands/SuspendAccount/SuspendAccountCommandEvent';

/**
 * An administrator suspends an account (request 34). Only an administrator may: anyone else is refused (403). The account decides
 * whether it changes: one already suspended changes nothing, records nothing and writes no entry. Otherwise it is saved, its entry of
 * the administrators' log is written and what it recorded is published, in one transaction; the time is the application's clock.
 * Nothing is written in any group. Its answer is the account's id.
 */
export class SuspendAccountCommandHandler extends CommandHandler<SuspendAccountCommandEvent> {
  constructor(
    private accounts: IAccountRepository,
    private log: IAdministratorsLog,
    private clock: Clock,
  ) {
    super();
  }

  /** What only an administrator may do is refused to anyone else (403). */
  protected async guard(_: SuspendAccountCommandEvent, { auth }: ExecutionContext): Promise<IResult<unknown>> {
    if (!auth.subjectId || auth.role !== Role.ADMIN) {
      return Result.fail(new NotAllowedException('Groups', 'Only an administrator suspends an account'));
    }
    return Result.ok();
  }

  async execute(event: SuspendAccountCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    // The guard let only an administrator through: their id is the caller's.
    const administrator = context.auth.subjectId!;

    const { accountId } = event.payload;
    const account = await this.accounts.findById(accountId);
    if (!account) return Result.fail(new NotFoundException('Groups', 'Account not found'));

    const at = this.clock();
    if (!account.suspend(at)) return Result.ok(accountId);

    const saved = await this.accounts.save(account);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.log.record(administratorsLogEntry({ at, by: administrator, action: 'suspended', subjectId: accountId }));
    await this.publishDomainEvents(account, context);
    return Result.ok(accountId);
  }
}
