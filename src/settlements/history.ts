import type { Database } from '../database';

/**
 * What a settlement's status is: `pending` and `failed` through the provider, `paid` once it counts, `refunding` and
 * `refunded` once it is refunded, `contested` once its payee says the money did not reach them, and `annulled` once an
 * administrator decides it was not paid.
 */
export type SettlementStatus = 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded' | 'contested' | 'annulled';

/** A status a settlement has had, and when Tally learned of it. */
export interface StatusEntry {
  status: SettlementStatus;
  at: string;
}

/**
 * Records that the settlement `settlementId` had `status` as Tally learned it at `at` (now, when not
 * given). Called only where a status is set, in the same transaction as the change, so the history's last
 * entry is always the settlement's status.
 */
export async function recordStatus(
  db: Database,
  settlementId: string,
  status: SettlementStatus,
  at?: string,
): Promise<void> {
  await db.execute('INSERT INTO settlement_statuses (settlement_id, status, at) VALUES (?, ?, ?)', [
    settlementId,
    status,
    at ?? new Date().toISOString(),
  ]);
}

/** Every status of the settlement, the earliest first. A settlement with no history is `[]`. */
export function historyOf(db: Database, settlementId: string): Promise<StatusEntry[]> {
  return db.rows<StatusEntry>('SELECT status, at FROM settlement_statuses WHERE settlement_id = ? ORDER BY id', [
    settlementId,
  ]);
}
