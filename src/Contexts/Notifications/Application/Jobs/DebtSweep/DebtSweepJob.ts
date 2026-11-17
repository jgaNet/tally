import { Clock, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';

import { IOutstandingDebts } from '@Contexts/Notifications/Application/Ports/IOutstandingDebts';
import { DEBT_THRESHOLD, DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { IDebtWatchRepository } from '@Contexts/Notifications/Domain/DebtWatch/Ports/IDebtWatchRepository';

/** How many times a watch is read and decided again when another sweep saved it first; the last conflict is left for the next run. */
const CONFLICT_ATTEMPTS = 3;

/**
 * The background sweep (ADR 10): at each run, it reads what every current member still owes, and for each member it sees owing, or
 * noted, decides their watch in a transaction of its own. A debt above the threshold is noted from the run that first sees it, and a
 * member noted for a period, and not reminded during the last one, is reminded (a notice of kind reminder, made by the reaction to
 * `ReminderIssued`). A debt no longer above the threshold is cleared. Nothing is decided by a read; the run has one clock.
 */
export class DebtSweepJob {
  constructor(
    private debts: IOutstandingDebts,
    private watches: IDebtWatchRepository,
    private clock: Clock,
    private periodSeconds: number,
  ) {}

  /** One run of the sweep, in the context the process gives it (a unit of work of its own, as a request has). */
  async run(context: ExecutionContext): Promise<void> {
    const now = this.clock();
    const seen = new Map<string, { groupId: string; memberId: string; owed: number }>();
    for (const debt of await this.debts.outstanding()) seen.set(keyOf(debt.groupId, debt.memberId), debt);
    for (const watch of await this.watches.findNoted()) {
      const key = keyOf(watch.groupId.value, watch.memberId.value);
      if (!seen.has(key)) seen.set(key, { groupId: watch.groupId.value, memberId: watch.memberId.value, owed: 0 });
    }

    for (const { groupId, memberId, owed } of seen.values()) {
      await this.decide(groupId, memberId, owed, now, context);
    }
  }

  /** One member's watch, decided in its own transaction; on a conflict it is read and decided again, up to the attempts. */
  private async decide(
    groupId: string,
    memberId: string,
    owed: number,
    now: Date,
    context: ExecutionContext,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const result = await context.withTransaction(() =>
        this.decideInTransaction(groupId, memberId, owed, now, context),
      );
      if (!result.isFailure()) return;

      const conflict = result.error instanceof ConcurrencyConflictException;
      if (conflict && attempt < CONFLICT_ATTEMPTS) continue;
      context.logger?.warn(`The debt sweep could not decide a debt: ${result.error.message}`, {
        traceId: context.traceId,
      });
      return;
    }
  }

  private async decideInTransaction(
    groupId: string,
    memberId: string,
    owed: number,
    now: Date,
    context: ExecutionContext,
  ): Promise<IResult<unknown>> {
    let watch = await this.watches.find(groupId, memberId);
    if (!watch) {
      if (owed <= DEBT_THRESHOLD) return Result.ok();
      watch = DebtWatch.open({ groupId: new Id(groupId), memberId: new Id(memberId) });
    }

    watch.see({ owed, now });
    watch.remindIfDue({ owed, now, period: this.periodSeconds * 1000 });
    const saved = await this.watches.save(watch);
    if (saved.isFailure()) return saved;

    await publishDomainEvents(watch, context);
    return Result.ok();
  }
}

const keyOf = (groupId: string, memberId: string): string => JSON.stringify([groupId, memberId]);
