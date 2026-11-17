import type { DatabaseSync } from 'node:sqlite';
import type { SettlementStatus } from './settlements';

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
 */
export function moveSettlement(db: DatabaseSync, settlementId: string, status: SettlementStatus, at: string): void {
  db.prepare('UPDATE settlements SET status = ? WHERE id = ?').run(status, settlementId);
  addHistory(db, settlementId, status, at);
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
