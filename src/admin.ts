import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { findAccount } from './accounts';
import type { Database, Queryable } from './database';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/**
 * What an administrator decided: on a settlement contested, that the money arrived or did not; on an account, that it is
 * suspended or reinstated.
 */
export const ADMIN_ACTIONS = ['decided-paid', 'decided-annulled', 'suspended', 'reinstated'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** A decision of an administrator, as the administrators' log keeps it. */
export interface AdminLogEntry {
  id: string;
  at: string;
  by: string;
  action: AdminAction;
  subjectId: string;
}

/** The decision made, before the entry is written. */
export interface NewAdminLogEntry {
  by: string;
  action: AdminAction;
  subjectId: string;
  at: string;
}

interface AdminLogRow {
  id: string;
  at: string;
  by: string;
  action: AdminAction;
  subject_id: string;
}

/**
 * The emails of the administrators, as `ADMIN_EMAILS` lists them: separated by commas. Each is kept in lowercase, so an account is
 * an administrator whatever the case of its email; blank entries are ignored.
 */
export function parseAdminEmails(list: string | undefined): string[] {
  return (list ?? '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(email => email !== '');
}

/** Whether the account is an administrator: its email is one of the emails the server was started with. */
export async function isAdministrator(
  db: Queryable,
  accountId: string,
  adminEmails: ReadonlySet<string>,
): Promise<boolean> {
  const account = await findAccount(db, accountId);
  return account !== undefined && adminEmails.has(account.email.toLowerCase());
}

/** Refuses an account that is not an administrator, for what only an administrator may do. */
export async function refuseUnlessAdministrator(
  db: Queryable,
  accountId: string,
  adminEmails: ReadonlySet<string>,
): Promise<void> {
  if (!(await isAdministrator(db, accountId, adminEmails))) {
    throw new Refusal(403, 'NotAllowed', 'Only an administrator may do this.');
  }
}

/** For what only an administrator reads: for anyone else it does not exist. */
export async function hideUnlessAdministrator(
  db: Queryable,
  accountId: string,
  adminEmails: ReadonlySet<string>,
  what: string,
): Promise<void> {
  if (!(await isAdministrator(db, accountId, adminEmails))) {
    throw new Refusal(404, 'NotFound', `There is no such ${what}.`);
  }
}

/**
 * Writes the entry of a decision of an administrator. It is called inside the write transaction of the decision, so the entry
 * exists exactly when the decision does. Nothing else writes or changes an entry.
 */
export async function writeAdminLog(db: Queryable, entry: NewAdminLogEntry): Promise<void> {
  await db.run('INSERT INTO admin_log (id, at, account_id, action, subject_id) VALUES (?, ?, ?, ?, ?)', [
    randomUUID(),
    entry.at,
    entry.by,
    entry.action,
    entry.subjectId,
  ]);
}

/**
 * The administrators' log, the oldest entry first. Only an administrator reads it: for anyone else it does not exist.
 * Reading changes nothing.
 */
export async function listAdminLog(
  db: Queryable,
  accountId: string,
  adminEmails: ReadonlySet<string>,
): Promise<AdminLogEntry[]> {
  await hideUnlessAdministrator(db, accountId, adminEmails, 'log');
  const rows = await db.all<AdminLogRow>(
    'SELECT id, at, account_id AS by, action, subject_id FROM admin_log ORDER BY seq',
  );
  return rows.map(row => ({
    id: row.id,
    at: row.at,
    by: row.by,
    action: row.action,
    subjectId: row.subject_id,
  }));
}

const adminLogEntrySchema = {
  type: 'object',
  required: ['id', 'at', 'by', 'action', 'subjectId'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
    by: { type: 'string' },
    action: { enum: [...ADMIN_ACTIONS] },
    subjectId: { type: 'string' },
  },
};

export function registerAdminRoutes(app: FastifyInstance, db: Database, adminEmails: ReadonlySet<string>): void {
  app.get(
    '/admin/log',
    { schema: { response: { 200: { type: 'array', items: adminLogEntrySchema } } } },
    async request => listAdminLog(db, await requireCaller(db, request), adminEmails),
  );
}
