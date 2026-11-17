import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { Clock, ExecutionContext, publishDomainEvents } from '@Architecture/Application';

import { DebtWatch, LINGERING_DEBT_OVER } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { OutstandingDebt } from '@Contexts/Notifications/Domain/DebtWatch/DTOs';
import { IDebtWatchRepository } from '@Contexts/Notifications/Domain/DebtWatch/Ports/IDebtWatchRepository';
import { IOutstandingDebts } from '@Contexts/Notifications/Domain/DebtWatch/Ports/IOutstandingDebts';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';

/**
 * The background job that reminds a member who has owed more than 2000 in a group for a period (request 18, the storm
 * `reminders`, ADR 10). At each run, every member who owes now and every member whose debt is noted is decided: noted, cleared,
 * or reminded, by the member's DebtWatch. Each member is decided in a transaction of its own, where the watch's change and the
 * reminder's notice are saved and what they record is published after the commit; a run that loses a race with another server
 * reads the watch again and decides again (CONC-OPTIMISTIC, up to three attempts). A member whose decision fails is logged, and
 * the next run tries again. The time is the application's clock, read once per run and handed to the aggregate.
 */
export class RemindLingeringDebtsJob {
  static readonly CONFLICT_ATTEMPTS = 3;

  constructor(
    private debts: IOutstandingDebts,
    private watches: IDebtWatchRepository,
    private notices: INoticeRepository,
    private clock: Clock,
  ) {}

  /** One run: `periodMs` is how long a debt must last, and how long apart two reminders are, for the same member and group. */
  async run(context: ExecutionContext, periodMs: number): Promise<void> {
    const at = this.clock();

    const decisions = new Map<string, OutstandingDebt>();
    for (const debt of await this.debts.owing()) decisions.set(keyOf(debt), debt);
    for (const { groupId, memberId } of await this.watches.notedMembers()) {
      const key = keyOf({ groupId, memberId });
      if (!decisions.has(key)) decisions.set(key, { groupId, memberId, owes: 0 });
    }

    for (const debt of decisions.values()) {
      try {
        const decided = await this.decideWithRetries(debt, at, periodMs, context);
        if (decided.isFailure()) {
          context.logger?.warn(`Debt of ${debt.memberId} in ${debt.groupId} not decided: ${decided.error.message}`, {
            traceId: context.traceId,
          });
        }
      } catch (error) {
        context.logger?.error(`Debt of ${debt.memberId} in ${debt.groupId} failed`, error, {
          traceId: context.traceId,
        });
      }
    }
  }

  private async decideWithRetries(
    debt: OutstandingDebt,
    at: Date,
    periodMs: number,
    context: ExecutionContext,
  ): Promise<IResult> {
    for (let attempt = 1; ; attempt++) {
      const result = await context.withTransaction(() => this.decide(debt, at, periodMs, context));
      const conflict = result.isFailure() && result.error instanceof ConcurrencyConflictException;
      if (!conflict || attempt >= RemindLingeringDebtsJob.CONFLICT_ATTEMPTS) return result;
      context.logger?.info(`A debt lost a race (attempt ${attempt} of ${RemindLingeringDebtsJob.CONFLICT_ATTEMPTS})`, {
        traceId: context.traceId,
      });
    }
  }

  private async decide(debt: OutstandingDebt, at: Date, periodMs: number, context: ExecutionContext): Promise<IResult> {
    const kept = await this.watches.findBy(debt.groupId, debt.memberId);
    if (!kept && debt.owes <= LINGERING_DEBT_OVER) return Result.ok();

    let watch = kept;
    if (!watch) {
      const opened = DebtWatch.open({ groupId: debt.groupId, memberId: debt.memberId });
      if (opened.isFailure()) return Result.fail(opened.error);
      watch = opened.data;
    }

    const { changed, reminded } = watch.observe({ owes: debt.owes, at, periodMs });
    if (!changed) return Result.ok();

    const saved = await this.watches.save(watch);
    if (saved.isFailure()) return Result.fail(saved.error);
    await publishDomainEvents(watch, context);

    if (reminded) {
      const notice = Notice.remind({ recipient: debt.memberId, groupId: debt.groupId, amount: debt.owes, at });
      if (notice.isFailure()) return Result.fail(notice.error);
      const noticed = await this.notices.save(notice.data);
      if (noticed.isFailure()) return Result.fail(noticed.error);
      await publishDomainEvents(notice.data, context);
    }
    return Result.ok();
  }
}

function keyOf({ groupId, memberId }: { groupId: string; memberId: string }): string {
  return `${groupId}\u0000${memberId}`;
}
