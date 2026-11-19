import { Clock, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { command, UseCase } from '@Architecture/Application/Lite/UseCase';
import { Result } from '@Architecture/Domain';

import { reminderAbove } from '@Contexts/Notifications/Domain/Debt/DebtWatch';
import { IDebtWatchQueries, IDebtWatches } from '@Contexts/Notifications/Domain/Debt/Ports/IDebtWatches';
import { IOutstandingDebts } from '@Contexts/Notifications/Domain/Debt/Ports/IOutstandingDebts';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INotices } from '@Contexts/Notifications/Domain/Notice/Ports/INotices';
import { INoticePreferences } from '@Contexts/Notifications/Domain/Preference/Ports/INoticePreferences';

/**
 * One member's debt in one group, as the sweep found it: `owed` is 0 when it owes nothing now (request 18), and `above` is the amount the
 * reminder is made above, in the group's currency's minor units (request 40), 0 for a member who owes nothing.
 */
export interface SweepInput {
  accountId: string;
  groupId: string;
  owed: number;
  above: number;
  periodMs: number;
}

/**
 * The sweep's step for one member and group, in its own transaction (request 18, docs/adr/0018): the watch is read, decided at the
 * run's time, and saved with the reminder it makes, if it makes one. A reminder is made only while the member has reminders on (request 36). A watch another server saved first is read again and decided
 * again, so the member is reminded once a period whatever the servers.
 */
export const sweepDebt = command(
  'SweepDebt',
  (watches: IDebtWatches, notices: INotices, preferences: INoticePreferences, clock: Clock) =>
    async ({ accountId, groupId, owed, above, periodMs }: SweepInput, context) => {
      const watch = await watches.get(accountId, groupId);
      const now = clock();
      // Reminders off (request 36): the debt is still noted, and not reminded; the reminder is made by the first run after they are on.
      const reminding = (await preferences.get(accountId)).isOn('reminder');
      const outcome = watch.sweep(owed, above, now, periodMs, reminding);
      if (outcome === 'none') return Result.ok(undefined);
      if (outcome === 'reminded') {
        const notice = Notice.remind({ accountId, groupId, amount: owed, at: now });
        await notices.save(notice);
        await publishDomainEvents(notice, context);
      }
      const saved = await watches.save(watch);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(watch, context);
      return Result.ok(undefined);
    },
);

/** The ports the background sweep runs with: what is owed now, what is noted, and the step it takes for each member. */
export interface DebtSweepPorts {
  debts: IOutstandingDebts;
  watchQueries: IDebtWatchQueries;
  sweep: UseCase<SweepInput, void>;
  periodMs: number;
}

const keyOf = (accountId: string, groupId: string) => `${groupId}\u0000${accountId}`;

/**
 * One run of the background sweep (request 18, docs/adr/0018): every member who owes more than the reminder's amount in its group's
 * currency now (request 40), and every member whose debt is noted (so that one which cleared is cleared, even when it owes nothing now),
 * is decided on by `SweepDebt` in its own transaction.
 * A member that fails is logged and the others go on; nothing is noted or reminded by a read.
 */
export async function sweepDebts(
  { debts, watchQueries, sweep, periodMs }: DebtSweepPorts,
  context: ExecutionContext,
): Promise<void> {
  const owing = await debts.outstandingDebts();
  const owedBy = new Map(owing.map(debt => [keyOf(debt.memberId, debt.groupId), debt]));
  const members = new Map<string, { accountId: string; groupId: string }>();
  for (const debt of owing) {
    if (debt.amount > reminderAbove(debt.currency))
      members.set(keyOf(debt.memberId, debt.groupId), { accountId: debt.memberId, groupId: debt.groupId });
  }
  for (const watch of await watchQueries.noted()) members.set(keyOf(watch.accountId, watch.groupId), watch);

  for (const [key, { accountId, groupId }] of members) {
    const debt = owedBy.get(key);
    const owed = debt?.amount ?? 0;
    // A member who owes nothing is cleared whatever the threshold, so none is read for it.
    const above = debt === undefined ? 0 : reminderAbove(debt.currency);
    const result = await sweep.run({ accountId, groupId, owed, above, periodMs }, context);
    if (result.isFailure())
      context.logger?.error(`The sweep of a debt failed for ${accountId} in ${groupId}`, result.error);
  }
}
