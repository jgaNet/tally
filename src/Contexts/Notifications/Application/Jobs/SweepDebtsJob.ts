import { Clock, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';
import { DEBT_THRESHOLD } from '@Contexts/Notifications/Domain/Debt/Threshold';
import { IDebtWatchRepository } from '@Contexts/Notifications/Domain/Debt/Ports/IDebtWatchRepository';
import { IOutstandingDebts, OutstandingDebt } from '@Contexts/Notifications/Domain/Debt/Ports/IOutstandingDebts';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { INoticePreferenceRepository } from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferenceRepository';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';

/**
 * The background job that keeps the debt watches and makes the reminders (request 18, ADR 12). Each run reads what every
 * current member still owes, and every member whose debt is noted, and looks at each of them once: a member seen over the
 * threshold is noted from this run, a member seen at or under it is cleared, and a lasting debt is reminded, with its notice,
 * in the same transaction as the watch that says so. Nothing is read by a request: only the run notes or reminds.
 *
 * A member is decided in a transaction of their own; a conflict with another server's run re-reads and re-decides, up to
 * three times (CONFLICT_ATTEMPTS), so a reminder is made once a period whatever the number of servers. The time is the
 * clock's, given once by the wiring, and the period is the wiring's: nothing here reads the machine's time.
 *
 * A reminder is made only to a member who turned reminders on (request 36, ADR 27). Turned off, the watch keeps the noting and
 * no reminder is counted as made, so the first run after they are on again reminds a member who still owes.
 */
export class SweepDebtsJob {
  static readonly CONFLICT_ATTEMPTS = 3;

  constructor(
    private readonly debts: IOutstandingDebts,
    private readonly watches: IDebtWatchRepository,
    private readonly notices: INoticeRepository,
    private readonly preferences: INoticePreferenceRepository,
    private readonly clock: Clock,
    private readonly reminderPeriodMs: number,
  ) {}

  async run(context: ExecutionContext): Promise<IResult<unknown>> {
    const at = this.clock();
    const seen = new Map<string, OutstandingDebt>();
    for (const debt of await this.debts.outstandingDebts()) seen.set(keyOf(debt), debt);
    // A member noted but owing nothing any more is seen at 0, so that the noting is cleared (a member who left, too).
    for (const noted of await this.watches.notedMembers()) {
      if (!seen.has(keyOf(noted))) seen.set(keyOf(noted), { ...noted, owed: 0 });
    }

    for (const debt of seen.values()) {
      const decided = await this.decide(debt, at, context);
      if (decided.isFailure()) {
        context.logger?.warn(
          `The debt of ${debt.memberId} in ${debt.groupId} was not decided: ${decided.error.message}`,
          {
            traceId: context.traceId,
          },
        );
      }
    }
    return Result.ok();
  }

  /** One member, decided in a transaction of its own, again from a fresh read when another run lost the race. */
  private async decide(debt: OutstandingDebt, at: Date, context: ExecutionContext): Promise<IResult<unknown>> {
    for (let attempt = 1; ; attempt++) {
      const result = await context.withTransaction(() => this.decideInTransaction(debt, at, context));
      const conflict = result.isFailure() && result.error instanceof ConcurrencyConflictException;
      if (!conflict || attempt >= SweepDebtsJob.CONFLICT_ATTEMPTS) return result;
    }
  }

  private async decideInTransaction(
    debt: OutstandingDebt,
    at: Date,
    context: ExecutionContext,
  ): Promise<IResult<unknown>> {
    const groupId = new Id(debt.groupId);
    const memberId = new Id(debt.memberId);
    const watch = await this.watches.findByMember(groupId, memberId);

    if (watch === null) {
      // Nothing noted and nothing over the threshold: nothing to keep.
      if (debt.owed <= DEBT_THRESHOLD) return Result.ok();
      const created = DebtWatch.create({ groupId, memberId, owed: debt.owed, at });
      if (created.isFailure()) return created;
      return this.save(created.data, context);
    }

    const remind = NoticePreferences.wants(await this.preferences.findByMember(memberId), 'reminder');
    const step = watch.observe({ owed: debt.owed, at, period: this.reminderPeriodMs, remind });
    if (step === 'unchanged') return Result.ok();
    const saved = await this.save(watch, context);
    if (saved.isFailure() || step === 'changed') return saved;

    const notice = Notice.createReminder({ memberId, groupId, amount: debt.owed, at });
    if (notice.isFailure()) return notice;
    const stored = await this.notices.save(notice.data);
    if (stored.isFailure()) return stored;
    await publishDomainEvents(notice.data, context);
    return Result.ok();
  }

  private async save(watch: DebtWatch, context: ExecutionContext): Promise<IResult<unknown>> {
    const stored = await this.watches.save(watch);
    if (stored.isFailure()) return stored;
    await publishDomainEvents(watch, context);
    return Result.ok();
  }
}

function keyOf(debt: { groupId: string; memberId: string }): string {
  return `${debt.groupId}/${debt.memberId}`;
}
