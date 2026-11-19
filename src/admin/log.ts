import { randomUUID } from 'node:crypto';
import type { Database } from '../database';

/** What an administrator decided about a contested settlement. */
export type AdministratorAction = 'decided-paid' | 'decided-annulled';

/** An entry of the administrators' log, as the administrators read it. */
export interface AdministratorLogEntry {
  id: string;
  /** When the decision was made. */
  at: string;
  /** The account id of the administrator who decided. */
  by: string;
  action: AdministratorAction;
  /** The settlement decided. */
  subjectId: string;
}

interface AdministratorLogRow {
  id: string;
  at: string;
  by_id: string;
  action: AdministratorAction;
  subject_id: string;
}

/**
 * Writes the entry of a decision of an administrator. It is called only inside the transaction of the decision, after
 * the decision is written, so the entry is there exactly when the decision is. Nothing else writes an entry.
 */
export async function recordAdministratorDecision(
  db: Database,
  administratorId: string,
  action: AdministratorAction,
  subjectId: string,
  at: string,
): Promise<void> {
  await db.execute('INSERT INTO admin_log (id, at, by_id, action, subject_id) VALUES (?, ?, ?, ?, ?)', [
    randomUUID(),
    at,
    administratorId,
    action,
    subjectId,
  ]);
}

/** Every decision of an administrator, the oldest first. Reading it changes nothing. */
export async function administratorLog(db: Database): Promise<AdministratorLogEntry[]> {
  const rows = await db.rows<AdministratorLogRow>(
    'SELECT id, at, by_id, action, subject_id FROM admin_log ORDER BY at, seq',
  );
  return rows.map(row => ({
    id: row.id,
    at: row.at,
    by: row.by_id,
    action: row.action,
    subjectId: row.subject_id,
  }));
}
