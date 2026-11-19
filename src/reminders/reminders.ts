import { randomUUID } from 'node:crypto';
import { isDeleted } from '../accounts/accounts';
import { balancesWithPendingOf } from '../balances/balances';
import { type Database, inTransaction } from '../database';

/** A member owing more than this, in hundredths of the group's currency (20.00), is noted, and may be reminded. */
export const REMINDED_ABOVE = 2000;

/**
 * One run of the background job's sweep over the debts, as of `at`. For every member of every group:
 *
 * - a member owing more than `REMINDED_ABOVE` and not noted is noted from this run;
 * - a member owing `REMINDED_ABOVE` or less is no longer noted;
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

    const groupIds = (await db.rows<{ id: string }>('SELECT id FROM groups')).map(row => row.id);
    for (const groupId of groupIds) {
      for (const { memberId, balance } of await balancesWithPendingOf(db, groupId)) {
        // A deleted account keeps its balance, and is told nothing of it.
        if (await isDeleted(db, memberId)) {
          continue;
        }
        const owed = -balance;
        if (owed <= REMINDED_ABOVE) {
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
        await db.execute(
          `INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
           VALUES (?, ?, 'reminder', ?, NULL, ?, ?)`,
          [randomUUID(), memberId, groupId, owed, now],
        );
      }
    }
  });
}
