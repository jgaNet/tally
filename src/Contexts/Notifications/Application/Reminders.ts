import { Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { command } from '@Architecture/Application/Lite/UseCase';
import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { decideSeeDebt } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch.decision';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

import { IDebtWatches } from './IDebtWatches';
import { IOutstandingDebts } from './IOutstandingDebts';

const keyOf = (groupId: string, memberId: string): string => JSON.stringify([groupId, memberId]);

/**
 * One run of the background job (request 18, ADR 15): it looks at what every member of every group still owes, notes the ones it
 * sees owe more than the threshold, stops noting the ones it sees owe less, and reminds the ones noted for a period and not reminded
 * during the last. The job calls it, nobody else: no read ever notes or reminds. `periodMs` is the period (`REMINDER_PERIOD_SECONDS`),
 * read when the run starts. Each watch is saved with the reminder it made in one transaction; a watch another server saved first is
 * a conflict, and the run is read again and finds the member reminded within the period.
 */
export const sweepDebts = command(
  'SweepDebts',
  (debts: IOutstandingDebts, watches: IDebtWatches, clock: Clock, periodMs: () => number) =>
    async (_input: void, context) => {
      const now = clock();
      const period = periodMs();
      const owedBy = new Map<string, { groupId: string; memberId: string; owed: number }>();
      for (const debt of await debts.outstandingDebts()) owedBy.set(keyOf(debt.groupId, debt.memberId), debt);
      const kept = new Map<string, DebtWatch>();
      for (const watch of await watches.all()) kept.set(keyOf(watch.groupId, watch.memberId), watch);

      for (const key of new Set([...owedBy.keys(), ...kept.keys()])) {
        const debt = owedBy.get(key);
        let watch = kept.get(key);
        const decision = decideSeeDebt(watch?.state, { owed: debt?.owed ?? 0, periodMs: period }, now);
        if (decision.isFailure()) return decision;
        if (decision.data.facts.length === 0) continue;

        let reminder: Notice | undefined;
        for (const fact of decision.data.facts) {
          if (fact.type === 'DebtNoted') {
            if (watch) watch.note(now);
            else watch = DebtWatch.create({ groupId: debt!.groupId, memberId: debt!.memberId, at: now });
          } else if (fact.type === 'DebtCleared') {
            watch!.clear(now);
          } else {
            reminder = Notice.remind({ memberId: watch!.memberId, groupId: watch!.groupId, owed: fact.owed, at: now });
            watch!.remind({ noticeId: reminder.toSnapshot().id, owed: fact.owed, at: now });
          }
        }
        await watches.save(watch!, reminder);
        await publishDomainEvents(watch!, context);
        if (reminder) await publishDomainEvents(reminder, context);
      }
      return Result.ok(undefined);
    },
  { caller: 'anyone' },
);
