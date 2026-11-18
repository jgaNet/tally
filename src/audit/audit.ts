import { randomUUID } from 'node:crypto';
import type { Database } from '../database';

/** A change of money in a group, as the audit names it. */
export type AuditAction =
  | 'expense-recorded'
  | 'expense-edited'
  | 'expense-deleted'
  | 'settlement-paid'
  | 'settlement-refunded'
  | 'balance-passed';

/** One change of money, as the audit answers it. */
export interface AuditEntry {
  id: string;
  /** When the change was made. */
  at: string;
  /** The account id of the member who made the change. */
  by: string;
  action: AuditAction;
  /** What the change is about: an expense, a settlement, or the member who left. */
  subjectId: string;
  /** What the change moved, in hundredths of the group's currency; negative when it moved a balance down. */
  amount: number;
}

interface AuditRow {
  id: string;
  at: string;
  by_id: string;
  action: AuditAction;
  subject_id: string;
  amount: number;
}

/**
 * Writes the entry of a change of money in `groupId`. It is called only inside the transaction of the change, after
 * the change is written, so the entry is there exactly when the change is. Nothing else writes an entry.
 */
export async function recordAudit(
  db: Database,
  groupId: string,
  change: { by: string; action: AuditAction; subjectId: string; amount: number },
  at: string,
): Promise<void> {
  await db.execute(
    'INSERT INTO audit_entries (id, group_id, at, by_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [randomUUID(), groupId, at, change.by, change.action, change.subjectId, change.amount],
  );
}

/** Every change of money in `groupId`, the oldest first. Reading it changes nothing. */
export async function auditOfGroup(db: Database, groupId: string): Promise<AuditEntry[]> {
  const rows = await db.rows<AuditRow>(
    `SELECT id, at, by_id, action, subject_id, amount FROM audit_entries
      WHERE group_id = ?
      ORDER BY at, seq`,
    [groupId],
  );
  return rows.map(row => ({
    id: row.id,
    at: row.at,
    by: row.by_id,
    action: row.action,
    subjectId: row.subject_id,
    amount: Number(row.amount),
  }));
}
