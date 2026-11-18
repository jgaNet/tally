import { randomUUID } from 'node:crypto';
import type { Database } from './database';
import { listBalancesIncludingWaiting } from './balances';
import { isDeleted } from './accounts';
import { isNoticeOn } from './notice-preferences';
import { minorUnitDigits } from './groups';

/**
 * A member owing more than 20 of the group's currency, in its minor unit, is noted, and reminded when it lasts: more than 2000
 * hundredths of euros or dollars, more than 20 yen, more than 20 000 fils of dinars.
 */
export function reminderThreshold(currency: string): number {
  return 20 * 10 ** minorUnitDigits(currency);
}

/** A week, in seconds: how long a debt must last to be reminded, and how long between two reminders. */
export const DEFAULT_REMINDER_PERIOD_SECONDS = 604_800;

/**
 * One run of the reminders, as the background job makes it. In one write transaction (so servers sharing the
 * database never both remind the same member): every current member's debt is looked at; a member owing more than
 * the threshold is noted from this run if not noted yet, one owing no more is no longer noted (nor is one who has
 * left); a member noted for `periodMs` or more, and not reminded during the last `periodMs`, is reminded, which
 * writes a notice of kind `reminder` with what they still owe.
 */
export async function runReminders(db: Database, periodMs: number, now: Date = new Date()): Promise<void> {
  const nowMs = now.getTime();
  const at = now.toISOString();
  await db.transaction(async tx => {
    const owing = new Set<string>();
    const groups = await tx.all<{ id: string; currency: string }>('SELECT id, currency FROM groups');
    const owed = new Map<string, number>();
    for (const { id: groupId, currency } of groups) {
      const threshold = reminderThreshold(currency);
      for (const { memberId, balance } of await listBalancesIncludingWaiting(tx, groupId)) {
        // A deleted account is told nothing any more, so its debt is not noted.
        if (-balance > threshold && !(await isDeleted(tx, memberId))) {
          owing.add(`${groupId}\n${memberId}`);
          owed.set(`${groupId}\n${memberId}`, -balance);
        }
      }
    }
    const noted = await tx.all<{
      group_id: string;
      account_id: string;
      noted_at: string;
      reminded_at: string | null;
    }>('SELECT group_id, account_id, noted_at, reminded_at FROM debt_notes');
    const known = new Set<string>();
    for (const row of noted) {
      const key = `${row.group_id}\n${row.account_id}`;
      if (!owing.has(key)) {
        await tx.run('DELETE FROM debt_notes WHERE group_id = ? AND account_id = ?', [row.group_id, row.account_id]);
        continue;
      }
      known.add(key);
      const notedLongEnough = nowMs - Date.parse(row.noted_at) >= periodMs;
      const recentlyReminded = row.reminded_at !== null && nowMs - Date.parse(row.reminded_at) < periodMs;
      // A reminder not made because reminders are off does not count as made: it is not kept as reminded, so the first run
      // that finds the member owing after they are on again reminds them.
      if (notedLongEnough && !recentlyReminded && (await isNoticeOn(tx, row.account_id, 'reminder'))) {
        await tx.run(
          `INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
           VALUES (?, ?, 'reminder', ?, NULL, ?, ?)`,
          [randomUUID(), row.account_id, row.group_id, owed.get(key) as number, at],
        );
        await tx.run('UPDATE debt_notes SET reminded_at = ? WHERE group_id = ? AND account_id = ?', [
          at,
          row.group_id,
          row.account_id,
        ]);
      }
    }
    for (const key of owing) {
      if (known.has(key)) continue;
      const [groupId, accountId] = key.split('\n');
      await tx.run('INSERT INTO debt_notes (group_id, account_id, noted_at) VALUES (?, ?, ?)', [
        groupId,
        accountId,
        at,
      ]);
    }
  });
}
