import { randomUUID } from 'node:crypto';
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
 * The whole sweep is one transaction, so several servers on the same file make each run in turn, and a
 * member is reminded at most once per period for a group, however many of them run. Only the members of a
 * group are seen, so only they are reminded: a member who leaves loses their note (see `leaveGroup`). Balances
 * count a settlement waiting at the provider as paid, as `balancesWithPendingOf` does: what is still owed is
 * read from those.
 */
export function sweepDebts(db: Database, at: Date, reminderPeriodMs: number): void {
  inTransaction(db, () => {
    const now = at.toISOString();
    const periodStart = new Date(at.getTime() - reminderPeriodMs).toISOString();

    const groupIds = (db.prepare('SELECT id FROM groups').all() as unknown as { id: string }[]).map(row => row.id);
    for (const groupId of groupIds) {
      for (const { memberId, balance } of balancesWithPendingOf(db, groupId)) {
        const owed = -balance;
        if (owed <= REMINDED_ABOVE) {
          db.prepare('DELETE FROM noted_debts WHERE group_id = ? AND account_id = ?').run(groupId, memberId);
          continue;
        }
        db.prepare('INSERT OR IGNORE INTO noted_debts (group_id, account_id, noted_at) VALUES (?, ?, ?)').run(
          groupId,
          memberId,
          now,
        );
        const noted = db
          .prepare('SELECT noted_at FROM noted_debts WHERE group_id = ? AND account_id = ?')
          .get(groupId, memberId) as { noted_at: string };
        if (noted.noted_at > periodStart) {
          continue;
        }
        const reminded = db
          .prepare(
            `SELECT 1 FROM notices
              WHERE account_id = ? AND group_id = ? AND kind = 'reminder' AND created_at > ?`,
          )
          .get(memberId, groupId, periodStart);
        if (reminded !== undefined) {
          continue;
        }
        db.prepare(
          `INSERT INTO notices (id, account_id, kind, group_id, expense_id, amount, created_at)
           VALUES (?, ?, 'reminder', ?, NULL, ?, ?)`,
        ).run(randomUUID(), memberId, groupId, owed, now);
      }
    }
  });
}
