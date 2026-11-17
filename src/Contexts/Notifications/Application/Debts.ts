import { Clock, publishDomainEvents } from '@Architecture/Application';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { command, UseCase } from '@Architecture/Application/Lite/UseCase';
import { Result } from '@Architecture/Domain';

import { REMINDED_ABOVE } from '@Contexts/Notifications/Domain/Debt/DebtWatch';
import { IDebtWatchQueries, IDebtWatches } from '@Contexts/Notifications/Domain/Debt/Ports/IDebtWatches';
import { IOutstandingDebts } from '@Contexts/Notifications/Domain/Debt/Ports/IOutstandingDebts';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INotices } from '@Contexts/Notifications/Domain/Notice/Ports/INotices';

/** One member's debt in one group, as the sweep found it: `owed` is 0 when it owes nothing now (request 18). */
export interface SweepInput {
  accountId: string;
  groupId: string;
  owed: number;
  periodMs: number;
}

/**
 * The sweep's step for one member and group, in its own transaction (request 18, docs/adr/0018): the watch is read, decided at the
 * run's time, and saved with the reminder it makes, if it makes one. A watch another server saved first is read again and decided
 * again, so the member is reminded once a period whatever the servers.
 */
export const sweepDebt = command(
  'SweepDebt',
  (watches: IDebtWatches, notices: INotices, clock: Clock) =>
    async ({ accountId, groupId, owed, periodMs }: SweepInput, context) => {
      const watch = await watches.get(accountId, groupId);
      const now = clock();
      const outcome = watch.sweep(owed, now, periodMs);
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
 * One run of the background sweep (request 18, docs/adr/0018): every member who owes more than 2000 now, and every member whose debt
 * is noted (so that one which cleared is cleared, even when it owes nothing now), is decided on by `SweepDebt` in its own transaction.
 * A member that fails is logged and the others go on; nothing is noted or reminded by a read.
 */
export async function sweepDebts(
  { debts, watchQueries, sweep, periodMs }: DebtSweepPorts,
  context: ExecutionContext,
): Promise<void> {
  const owing = await debts.outstandingDebts();
  const owedBy = new Map(owing.map(debt => [keyOf(debt.memberId, debt.groupId), debt.amount]));
  const members = new Map<string, { accountId: string; groupId: string }>();
  for (const debt of owing) {
    if (debt.amount > REMINDED_ABOVE)
      members.set(keyOf(debt.memberId, debt.groupId), { accountId: debt.memberId, groupId: debt.groupId });
  }
  for (const watch of await watchQueries.noted()) members.set(keyOf(watch.accountId, watch.groupId), watch);

  for (const [key, { accountId, groupId }] of members) {
    const result = await sweep.run({ accountId, groupId, owed: owedBy.get(key) ?? 0, periodMs }, context);
    if (result.isFailure())
      context.logger?.error(`The sweep of a debt failed for ${accountId} in ${groupId}`, result.error);
  }
}
