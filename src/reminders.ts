import type { DatabaseSync } from 'node:sqlite';
import { balancesOfGroup } from './balances';
import { noticeReminder } from './notices';
import { inTransaction } from './transactions';

/** A member is reminded when they still owe more than this in a group (20.00 in its currency). */
export const REMINDER_THRESHOLD = 2000;

/** A week, in seconds: how long a debt lasts before it is reminded, and how often it is reminded again. */
export const DEFAULT_REMINDER_PERIOD_SECONDS = 604_800;

interface LastingDebtRow {
  account_id: string;
  noted_at: string;
  last_reminded_at: string | null;
}

/**
 * One run of the reminders, at `now`, over every group: what each current member still owes (counting a
 * settlement waiting at the provider as paid, as request 13 counts what is still owed) is looked at.
 *
 * - A member owing more than {@link REMINDER_THRESHOLD} who was not noted is noted from `now`.
 * - A member owing that much or less, or no longer a member, is no longer noted: a debt that comes back is noted
 *   again from the run that sees it.
 * - A member noted for `periodMs` or more, and not reminded in the last `periodMs`, is reminded at `now`.
 *
 * The run is one write transaction (`BEGIN IMMEDIATE`): servers sharing the file run it one after the other, and
 * each sees what the one before it noted and reminded, so a member is reminded at most once a period for a group.
 * An archived group is not looked at: it changes nothing. Answers how many reminders it made.
 */
export function sweepReminders(db: DatabaseSync, now: Date, periodMs: number): number {
  const at = now.toISOString();
  const nowMs = now.getTime();
  return inTransaction(db, () => {
    let reminded = 0;
    const groups = db
      .prepare('SELECT id FROM groups WHERE archived_at IS NULL ORDER BY created_at ASC, rowid ASC')
      .all() as unknown as {
      id: string;
    }[];
    const watchedOf = db.prepare('SELECT account_id, noted_at, last_reminded_at FROM lasting_debts WHERE group_id = ?');
    const note = db.prepare('INSERT INTO lasting_debts (group_id, account_id, noted_at) VALUES (?, ?, ?)');
    const forget = db.prepare('DELETE FROM lasting_debts WHERE group_id = ? AND account_id = ?');
    const markReminded = db.prepare(
      'UPDATE lasting_debts SET last_reminded_at = ? WHERE group_id = ? AND account_id = ?',
    );
    for (const group of groups) {
      const owing = new Map<string, number>();
      for (const { memberId, balance } of balancesOfGroup(db, group.id, { includePending: true })) {
        if (-balance > REMINDER_THRESHOLD) owing.set(memberId, -balance);
      }
      const watched = new Map(
        (watchedOf.all(group.id) as unknown as LastingDebtRow[]).map(row => [row.account_id, row]),
      );
      for (const accountId of watched.keys()) {
        if (!owing.has(accountId)) forget.run(group.id, accountId);
      }
      for (const [accountId, amount] of owing) {
        const debt = watched.get(accountId);
        if (!debt) {
          note.run(group.id, accountId, at);
          continue;
        }
        const lasted = nowMs - Date.parse(debt.noted_at) >= periodMs;
        const remindedLately = debt.last_reminded_at !== null && nowMs - Date.parse(debt.last_reminded_at) < periodMs;
        if (lasted && !remindedLately) {
          noticeReminder(db, { recipientId: accountId, groupId: group.id, amount, at });
          markReminded.run(at, group.id, accountId);
          reminded += 1;
        }
      }
    }
    return reminded;
  });
}
