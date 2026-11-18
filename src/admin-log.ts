import { randomUUID } from 'node:crypto';
import type { Database, Querier } from './database';

/**
 * The decisions an administrator makes about a contested settlement, and the suspensions and reinstatements of an account
 * (see {@link recordAdminLog}).
 */
export const ADMIN_ACTIONS = ['decided-paid', 'decided-annulled', 'suspended', 'reinstated'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** One change an administrator makes. `at` is an ISO 8601 instant; `by` is the administrator's account id. */
export interface AdminLogEntry {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  readonly action: AdminAction;
  /** The settlement a decision is about, or the account a suspension or reinstatement is about. */
  readonly subjectId: string;
}

interface AdminLogRow {
  id: string;
  at: string;
  by_id: string;
  action: AdminAction;
  subject_id: string;
}

/**
 * Writes the entry of one decision of an administrator. It is written in the caller's transaction, so the entry exists exactly
 * when the decision does. Nothing changes or removes an entry.
 */
export async function recordAdminLog(
  db: Querier,
  input: { at: string; by: string; action: AdminAction; subjectId: string },
): Promise<void> {
  await db
    .prepare('INSERT INTO admin_log (id, at, by_id, action, subject_id) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), input.at, input.by, input.action, input.subjectId);
}

/**
 * The administrators' log, the oldest first. Only an administrator reads it (see `routes/admin.ts`). It changes nothing.
 */
export async function adminLogOf(db: Database): Promise<AdminLogEntry[]> {
  const rows = await db
    .prepare('SELECT id, at, by_id, action, subject_id FROM admin_log ORDER BY at ASC, seq ASC')
    .all<AdminLogRow>();
  return rows.map(row => ({
    id: row.id,
    at: row.at,
    by: row.by_id,
    action: row.action,
    subjectId: row.subject_id,
  }));
}
