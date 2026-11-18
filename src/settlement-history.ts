import type { DatabaseSync } from 'node:sqlite';
import { writeAudit } from './audit';
import type { SettlementStatus } from './settlements';

/** The statuses a settlement's balances count: `paid`, and `refunding` until the refund is said to be done. */
const COUNTED: readonly SettlementStatus[] = ['paid', 'refunding'];

/** A settlement as a status change of it reads it: its group, its parties, its amount, its method and its status now. */
interface SettlementState {
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash' | 'provider';
  status: SettlementStatus;
}

/** A status a settlement has had, with the moment Tally learned it. */
export interface StatusEntry {
  status: SettlementStatus;
  at: string;
}

/** Writes the first entry of a settlement's history: the status it was recorded with. */
export function addHistory(db: DatabaseSync, settlementId: string, status: SettlementStatus, at: string): void {
  db.prepare('INSERT INTO settlement_history (settlement_id, status, at) VALUES (?, ?, ?)').run(
    settlementId,
    status,
    at,
  );
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
export function moveSettlement(db: DatabaseSync, settlementId: string, status: SettlementStatus, at: string): void {
  const before = db
    .prepare('SELECT group_id, payer_id, payee_id, amount, method, status FROM settlements WHERE id = ?')
    .get(settlementId) as unknown as SettlementState;
  db.prepare('UPDATE settlements SET status = ? WHERE id = ?').run(status, settlementId);
  addHistory(db, settlementId, status, at);
  const countedBefore = COUNTED.includes(before.status);
  const countedAfter = COUNTED.includes(status);
  if (countedBefore === countedAfter) return;
  if (countedAfter) {
    writeAudit(db, before.group_id, {
      by: before.method === 'cash' ? before.payee_id : before.payer_id,
      action: 'settlement-paid',
      subjectId: settlementId,
      amount: before.amount,
      at,
    });
  } else {
    writeAudit(db, before.group_id, {
      by: before.payee_id,
      action: 'settlement-refunded',
      subjectId: settlementId,
      amount: before.amount,
      at,
    });
  }
}

/** The statuses a settlement has had, the earliest first. */
export function historyOf(db: DatabaseSync, settlementId: string): StatusEntry[] {
  return (
    db
      .prepare('SELECT status, at FROM settlement_history WHERE settlement_id = ? ORDER BY seq')
      .all(settlementId) as unknown as StatusEntry[]
  ).map(entry => ({ status: entry.status, at: entry.at }));
}

/** Removes the history of a settlement, for a settlement that is about to be deleted. */
export function forgetHistory(db: DatabaseSync, settlementId: string): void {
  db.prepare('DELETE FROM settlement_history WHERE settlement_id = ?').run(settlementId);
}
