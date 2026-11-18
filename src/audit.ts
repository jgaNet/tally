import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Refusal } from './refusal';
import { inReadSnapshot } from './transactions';

/** The changes of money an audit records, each about the subject it names (see {@link recordAudit}). */
export const AUDIT_ACTIONS = [
  'expense-recorded',
  'expense-edited',
  'expense-deleted',
  'settlement-paid',
  'settlement-refunded',
  'balance-passed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** One change of money in a group, as a member of the group reads it. `at` is an ISO 8601 instant. */
export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  /** The account that made the change. */
  readonly by: string;
  readonly action: AuditAction;
  /** What the change is about: an expense, a settlement, or the member who left. */
  readonly subjectId: string;
  /** How much money the change moved, in hundredths of the group's currency; negative for a balance passed on that owes. */
  readonly amount: number;
}

/**
 * Writes the entry of one change of money in the group. It is written in the caller's transaction, so the entry exists
 * exactly when the change does; nothing writes one for a change refused, or one that changes nothing.
 */
export function recordAudit(
  db: DatabaseSync,
  input: { groupId: string; at: string; by: string; action: AuditAction; subjectId: string; amount: number },
): void {
  db.prepare(
    'INSERT INTO audit_entries (id, group_id, at, by_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), input.groupId, input.at, input.by, input.action, input.subjectId, input.amount);
}

/**
 * The audit of the group, the oldest first. Only a current member of the group reads it: to anyone else, and to a
 * member who has left, the group does not exist (`404`). Reading one consistent state of the file, it changes nothing.
 */
export function auditOfGroup(db: DatabaseSync, readerId: string, groupId: string): AuditEntry[] {
  return inReadSnapshot(db, () => {
    // A current membership is the group's, as the other reads of a group are: anyone else is refused as if it did not exist.
    const member = db
      .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ? AND left_at IS NULL')
      .get(groupId, readerId);
    if (member === undefined) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const rows = db
      .prepare(
        `SELECT id, at, by_id, action, subject_id, amount FROM audit_entries
         WHERE group_id = ? ORDER BY at ASC, rowid ASC`,
      )
      .all(groupId) as unknown as {
      id: string;
      at: string;
      by_id: string;
      action: AuditAction;
      subject_id: string;
      amount: number;
    }[];
    return rows.map(row => ({
      id: row.id,
      at: row.at,
      by: row.by_id,
      action: row.action,
      subjectId: row.subject_id,
      amount: Number(row.amount),
    }));
  });
}
