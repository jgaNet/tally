import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
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
export async function writeAudit(db: Queryable, groupId: string, entry: NewAuditEntry): Promise<void> {
  await db.run(
    'INSERT INTO audit_entries (id, group_id, at, account_id, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [randomUUID(), groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount],
  );
}

/**
 * The group's audit, the oldest entry first. Only a member of the group reads it: for anyone else the group does not
 * exist, and so does not the audit. Reading changes nothing.
 */
export async function listAuditOf(db: Queryable, accountId: string, groupId: string): Promise<AuditEntry[]> {
  if (!(await findGroupOf(db, accountId, groupId))) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const rows = await db.all<AuditRow>(
    'SELECT id, at, account_id AS by, action, subject_id, amount FROM audit_entries WHERE group_id = ? ORDER BY seq',
    [groupId],
  );
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

export function registerAuditRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/audit',
    { schema: { response: { 200: { type: 'array', items: auditEntrySchema } } } },
    async request => listAuditOf(db, await requireCaller(db, request), request.params.id),
  );
}
