import { IResult, Result } from '@Architecture/Domain';
import { Clock, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { command } from '@Architecture/Application/Lite/UseCase';

import { IDebtWatchStore } from '@Contexts/Notifications/Application/IDebtWatchStore';
import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';
import { IOutstandingDebts } from '@Contexts/Notifications/Application/IOutstandingDebts';
import { DEBT_THRESHOLD, DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

/** The key of a watch: one per member and group. */
const keyOf = (groupId: string, memberId: string): string => `${groupId}\u0000${memberId}`;

/**
 * The background sweep (request 18, the storm's `SweepDebts`): what every member of every group still owes is looked at once per run.
 * A member seen owing more than the threshold is noted from this run if they were not; a member noted for a period or more, and not
 * reminded during the last period, is reminded now, with a reminder notice of their own. A member seen at or below it, or no longer a
 * member of the group, is cleared. Nothing is decided by a read: only this run writes the watches and the notices, in one transaction,
 * so a conflict with another server's run runs the whole sweep again on what it committed (CONFLICT_ATTEMPTS).
 *
 * It is started by the composition root, every JOBS_INTERVAL_SECONDS, with the one clock the wiring passes and the reminder period
 * (REMINDER_PERIOD_SECONDS) as a parameter. It has no caller: nothing routes to it.
 */
export const sweepDebts = command(
  'SweepDebts',
  (watches: IDebtWatchStore, debts: IOutstandingDebts, notices: INoticeStore, clock: Clock, reminderPeriodMs: number) =>
    async (_: void, context): Promise<IResult<void>> => {
      const now = clock();
      const known = new Map((await watches.all()).map(watch => [keyOf(watch.groupId, watch.memberId), watch]));
      const seen = new Set<string>();

      for (const { groupId, memberId, owes } of await debts.debtsOf()) {
        const key = keyOf(groupId, memberId);
        seen.add(key);
        if (!known.has(key) && owes <= DEBT_THRESHOLD) continue;

        const watch = known.get(key) ?? DebtWatch.create({ groupId, memberId });
        const { reminderDue } = watch.sight(owes, now, reminderPeriodMs);
        if (reminderDue) {
          watch.remind(owes, now);
          const notice = Notice.reminder({ recipientId: memberId, groupId, amount: owes }, now);
          await notices.add(notice);
          await publishDomainEvents(notice, context);
        }
        await saveIfChanged(watch, watches, context);
      }

      for (const [key, watch] of known) {
        if (seen.has(key)) continue;
        watch.clear(now);
        await saveIfChanged(watch, watches, context);
      }
      return Result.ok(undefined);
    },
);

/** A watch the sweep changed is stored, then its facts are published (EVENT-AFTER-COMMIT); an unchanged one is left as it is. */
async function saveIfChanged(watch: DebtWatch, watches: IDebtWatchStore, context: ExecutionContext): Promise<void> {
  if (!watch.changed) return;
  await watches.save(watch);
  await publishDomainEvents(watch, context);
}
