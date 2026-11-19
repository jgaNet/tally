import { recordAudit } from '../audit/audit';
import { type Database, inTransaction } from '../database';
import { leftMembersAmong, requireNotArchived } from '../groups/groups';
import { recordAdministratorEntry } from '../admin/log';
import { Refusal } from '../refusal';
import { recordStatus } from './history';
import { requireSettlement, settledAmountOf } from './settlements';

/**
 * Contests the settlement `settlementId` for its payee `accountId`: the money did not reach them. Only the payee may,
 * and only once for a settlement: one whose history has a `contested` entry is refused whatever its status is now.
 * Only a settlement through the provider that is `paid` can be contested. Its payer and its payee must both still be
 * members of its group, and the group must not be archived.
 *
 * Anyone outside the group is refused with `404`, as for a settlement that does not exist; a member who is not its
 * payee with `403`. Any other refusal is `409`. Nothing is changed by a refusal.
 *
 * The settlement is held as `contested`: the balances stop counting it, as they were before it was paid, while what
 * its payer still owes and what its payee is still owed count it as paid, as they do while a payment waits at the
 * provider. The audit records `settlement-contested` by the payee, with the amount. A webhook about its payment
 * changes nothing. Written in one transaction, under the write lock.
 */
export async function contestSettlement(db: Database, settlementId: string, accountId: string): Promise<void> {
  await inTransaction(db, async () => {
    const settlement = await requireSettlement(db, settlementId, accountId);
    await requireNotArchived(db, settlement.groupId);
    if (settlement.to !== accountId) {
      throw new Refusal(403, 'NotPayee', 'Only the member who was paid can contest a settlement.');
    }
    if (settlement.history.some(entry => entry.status === 'contested')) {
      throw new Refusal(409, 'AlreadyContested', 'This settlement has been contested once already.');
    }
    if (settlement.method !== 'provider' || settlement.status !== 'paid') {
      throw new Refusal(409, 'NotContestable', 'Only a payment through the provider that is paid can be contested.');
    }
    if ((await leftMembersAmong(db, settlement.groupId, [settlement.from, settlement.to])).length > 0) {
      throw new Refusal(
        409,
        'MemberHasLeft',
        'A member of this settlement has left the group, so it cannot be contested: the balances must add up to 0.',
      );
    }
    const at = new Date().toISOString();
    await db.execute(`UPDATE settlements SET status = 'contested' WHERE id = ? AND status = 'paid'`, [settlementId]);
    await recordStatus(db, settlementId, 'contested', at);
    await recordAudit(
      db,
      settlement.groupId,
      {
        by: accountId,
        action: 'settlement-contested',
        subjectId: settlementId,
        amount: await settledAmountOf(db, settlementId),
      },
      at,
    );
  });
}

/**
 * Decides the contested settlement `settlementId` for the administrator `administratorId`: `paid` when the money
 * arrived, and the settlement is `paid` again, counted as it was before it was contested, with a `settlement-paid`
 * audit entry by the administrator; otherwise it is `annulled`, and nothing counts it any more, so what was owed is
 * owed again. Either way the administrators' log keeps the decision. Only a contested settlement is decided, once:
 * any other is refused with `409`, and an unknown one with `404`. Written in one transaction, under the write lock.
 */
export async function decideContest(
  db: Database,
  settlementId: string,
  administratorId: string,
  paid: boolean,
): Promise<void> {
  await inTransaction(db, async () => {
    const row = await db.row<{ status: string; group_id: string; settled_amount: number }>(
      'SELECT status, group_id, settled_amount FROM settlements WHERE id = ?',
      [settlementId],
    );
    if (row === undefined) {
      throw new Refusal(404, 'NotFound', 'There is no such settlement.');
    }
    if (row.status !== 'contested') {
      throw new Refusal(409, 'NotContested', 'Only a contested settlement is decided, and only once.');
    }
    const at = new Date().toISOString();
    const status = paid ? 'paid' : 'annulled';
    await db.execute(`UPDATE settlements SET status = ? WHERE id = ? AND status = 'contested'`, [status, settlementId]);
    await recordStatus(db, settlementId, status, at);
    if (paid) {
      await recordAudit(
        db,
        row.group_id,
        { by: administratorId, action: 'settlement-paid', subjectId: settlementId, amount: row.settled_amount },
        at,
      );
    }
    await recordAdministratorEntry(db, administratorId, paid ? 'decided-paid' : 'decided-annulled', settlementId, at);
  });
}
