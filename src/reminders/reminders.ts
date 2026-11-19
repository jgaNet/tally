import { randomUUID } from 'node:crypto';
import { isDeleted } from '../accounts/accounts';
import { balancesWithPendingOf } from '../balances/balances';
import { type Database, inTransaction } from '../database';
import { type Currency, minorUnitDigitsOf } from '../groups/validation';
import { isNoticeOn } from '../notices/preferences';

/** A member owing more than this many of the group's currency is noted, and may be reminded. */
const REMINDED_ABOVE_UNITS = 20;

/**
 * What a member of a group in `currency` must owe to be noted and reminded: more than 20 of it, in its minor unit, so
 * 2000 hundredths (20.00) of euros, 20 yen, and 20000 thousandths (20.000) of dinars.
 */
export function reminderAboveOf(currency: Currency): number {
  return REMINDED_ABOVE_UNITS * 10 ** minorUnitDigitsOf(currency);
}

/**
 * One run of the background job's sweep over the debts, as of `at`. For every member of every group:
 *
 * - a member owing more than `reminderAboveOf` the group's currency and not noted is noted from this run;
 * - a member owing `reminderAboveOf` or less is no longer noted;
 * - a member noted for `reminderPeriodMs` or more, and not reminded during that period, is reminded
 *   at this run: a notice of kind `reminder` with what they still owe.
 *
 * The whole sweep is one transaction, so several servers on the same database make each run in turn, and a
 * member is reminded at most once per period for a group, however many of them run. Only the members of a
 * group are seen, so only they are reminded: a member who leaves loses their note (see `leaveGroup`). Balances
 * count a settlement waiting at the provider as paid, as `balancesWithPendingOf` does: what is still owed is
 * read from those.
 */
export async function sweepDebts(db: Database, at: Date, reminderPeriodMs: number): Promise<void> {
  await inTransaction(db, async () => {
    const now = at.toISOString();
    const periodStart = new Date(at.getTime() - reminderPeriodMs).toISOString();

    const groups = await db.rows<{ id: string; currency: Currency }>('SELECT id, currency FROM groups');
    for (const { id: groupId, currency } of groups) {
      const above = reminderAboveOf(currency);
      for (const { memberId, balance } of await balancesWithPendingOf(db, groupId)) {
        // A deleted account keeps its balance, and is told nothing of it.
        if (await isDeleted(db, memberId)) {
          continue;
        }
        const owed = -balance;
        if (owed <= above) {
          await db.execute('DELETE FROM noted_debts WHERE group_id = ? AND account_id = ?', [groupId, memberId]);
          continue;
        }
        await db.execute(
          'INSERT INTO noted_debts (group_id, account_id, noted_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
          [groupId, memberId, now],
        );
        const noted = await db.row<{ noted_at: string }>(
          'SELECT noted_at FROM noted_debts WHERE group_id = ? AND account_id = ?',
          [groupId, memberId],
        );
        if ((noted as { noted_at: string }).noted_at > periodStart) {
          continue;
        }
        const reminded = await db.row(
          `SELECT 1 FROM notices
            WHERE account_id = ? AND group_id = ? AND kind = 'reminder' AND created_at > ?`,
          [memberId, groupId, periodStart],
        );
        if (reminded !== undefined) {
          continue;
        }
        // A member who has turned reminders off is not reminded at this run, and a reminder not made does not count as
        // made: once they are on again, the next run that would remind them does.
        if (!(await isNoticeOn(db, memberId, 'reminder'))) {
          continue;
        }
        await db.execute(
          `INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
           VALUES (?, ?, 'reminder', ?, NULL, ?, ?)`,
          [randomUUID(), memberId, groupId, owed, now],
        );
      }
    }
  });
}
