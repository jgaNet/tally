import type { Database } from '../database';

/** A status a settlement has had, and when Tally learned of it. */
export interface StatusEntry {
  status: 'pending' | 'paid' | 'failed' | 'refunding' | 'refunded';
  at: string;
}

/**
 * Records that the settlement `settlementId` had `status` as Tally learned it at `at` (now, when not
 * given). Called only where a status is set, in the same transaction as the change, so the history's last
 * entry is always the settlement's status.
 */
export function recordStatus(db: Database, settlementId: string, status: StatusEntry['status'], at?: string): void {
  db.prepare('INSERT INTO settlement_statuses (settlement_id, status, at) VALUES (?, ?, ?)').run(
    settlementId,
    status,
    at ?? new Date().toISOString(),
  );
}

/** Every status of the settlement, the earliest first. A settlement with no history is `[]`. */
export function historyOf(db: Database, settlementId: string): StatusEntry[] {
  return db
    .prepare('SELECT status, at FROM settlement_statuses WHERE settlement_id = ? ORDER BY id')
    .all(settlementId) as unknown as StatusEntry[];
}
