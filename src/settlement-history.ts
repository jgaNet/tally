import type { Queryable } from './database';
import { writeAudit } from './audit';
import type { SettlementMethod, SettlementStatus } from './settlements';

/** The statuses a settlement's balances count: `paid`, and `refunding` until the refund is said to be done. */
const COUNTED: readonly SettlementStatus[] = ['paid', 'refunding'];

/** A settlement as a status change of it reads it: its group, its parties, its amount, its method and its status now. */
interface SettlementState {
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
}

/** A status a settlement has had, with the moment Tally learned it. */
export interface StatusEntry {
  status: SettlementStatus;
  at: string;
}

/** Writes the first entry of a settlement's history: the status it was recorded with. */
export async function addHistory(
  db: Queryable,
  settlementId: string,
  status: SettlementStatus,
  at: string,
): Promise<void> {
  await db.run('INSERT INTO settlement_history (settlement_id, status, at) VALUES (?, ?, ?)', [
    settlementId,
    status,
    at,
  ]);
}

/**
 * Moves a settlement to `status`, learned at `at`, and writes the entry it adds to its history. Every change of a
 * settlement's status goes through here, so the history is every status it has had, the earliest first. The caller
 * has decided the change, in the same write transaction.
 *
 * A move that starts the balances to count the settlement (it becomes `paid`) is an audit entry of `settlement-paid`,
 * made by its payer when it is paid through the provider; a move that ends the count (it becomes `refunded`) is one of
 * `settlement-refunded`, made by its payee. A move that does not change whether the balances count it (`refunding`, or
 * a settlement never counted, going to `refunded` or `failed`) has none.
 */
export async function moveSettlement(
  db: Queryable,
  settlementId: string,
  status: SettlementStatus,
  at: string,
): Promise<void> {
  const before = await db.get<SettlementState>(
    'SELECT group_id, payer_id, payee_id, amount, method, status FROM settlements WHERE id = ?',
    [settlementId],
  );
  if (!before) throw new Error(`settlement ${settlementId} is not kept`);
  await db.run('UPDATE settlements SET status = ? WHERE id = ?', [status, settlementId]);
  await addHistory(db, settlementId, status, at);
  const countedBefore = COUNTED.includes(before.status);
  const countedAfter = COUNTED.includes(status);
  if (countedBefore === countedAfter) return;
  if (countedAfter) {
    await writeAudit(db, before.group_id, {
      by: before.method === 'cash' ? before.payee_id : before.payer_id,
      action: 'settlement-paid',
      subjectId: settlementId,
      amount: before.amount,
      at,
    });
  } else {
    await writeAudit(db, before.group_id, {
      by: before.payee_id,
      action: 'settlement-refunded',
      subjectId: settlementId,
      amount: before.amount,
      at,
    });
  }
}

/** The statuses a settlement has had, the earliest first. */
export async function historyOf(db: Queryable, settlementId: string): Promise<StatusEntry[]> {
  const entries = await db.all<StatusEntry>(
    'SELECT status, at FROM settlement_history WHERE settlement_id = ? ORDER BY seq',
    [settlementId],
  );
  return entries.map(entry => ({ status: entry.status, at: entry.at }));
}

/** Removes the history of a settlement, for a settlement that is about to be deleted. */
export async function forgetHistory(db: Queryable, settlementId: string): Promise<void> {
  await db.run('DELETE FROM settlement_history WHERE settlement_id = ?', [settlementId]);
}
