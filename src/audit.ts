import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { findGroupOf } from './groups';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/** The changes of money the audit records: one entry each. */
export const AUDIT_ACTIONS = [
  'expense-recorded',
  'expense-edited',
  'expense-deleted',
  'settlement-paid',
  'settlement-refunded',
  'balance-passed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** A change of money, as the audit keeps it: who made it, when, what it did to what, and how much. */
export interface AuditEntry {
  id: string;
  at: string;
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
}

/** The change an entry records, before the entry is written. */
export interface NewAuditEntry {
  by: string;
  action: AuditAction;
  subjectId: string;
  amount: number;
  at: string;
}

interface AuditRow {
  id: string;
  at: string;
  by: string;
  action: AuditAction;
  subject_id: string;
  amount: number;
}

/**
 * Writes the entry of a change of money in the group. It is called inside the write transaction of the change, so the
 * entry exists exactly when the change does, however many servers share the database. Nothing else writes or changes an
 * entry.
 */
export function writeAudit(db: DatabaseSync, groupId: string, entry: NewAuditEntry): void {
  db.prepare(
    'INSERT INTO audit_entries (id, group_id, at, account_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount);
}

/**
 * The group's audit, the oldest entry first. Only a member of the group reads it: for anyone else the group does not
 * exist, and so does not the audit. Reading changes nothing.
 */
export function listAuditOf(db: DatabaseSync, accountId: string, groupId: string): AuditEntry[] {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const rows = db
    .prepare(
      'SELECT id, at, account_id AS by, action, subject_id, amount FROM audit_entries WHERE group_id = ? ORDER BY seq',
    )
    .all(groupId) as unknown as AuditRow[];
  return rows.map(row => ({
    id: row.id,
    at: row.at,
    by: row.by,
    action: row.action,
    subjectId: row.subject_id,
    amount: row.amount,
  }));
}

const auditEntrySchema = {
  type: 'object',
  required: ['id', 'at', 'by', 'action', 'subjectId', 'amount'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
    by: { type: 'string' },
    action: { enum: [...AUDIT_ACTIONS] },
    subjectId: { type: 'string' },
    amount: { type: 'integer' },
  },
};

export function registerAuditRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/audit',
    { schema: { response: { 200: { type: 'array', items: auditEntrySchema } } } },
    request => listAuditOf(db, requireCaller(db, request), request.params.id),
  );
}
