import type { FastifyInstance } from 'fastify';
import { findAccount } from './accounts';
import { refuseUnlessAdministrator, writeAdminLog } from './admin';
import type { Database, Queryable } from './database';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/** Whether the account is suspended: an administrator suspended it, and no administrator has reinstated it since. */
export async function isSuspended(db: Queryable, accountId: string): Promise<boolean> {
  return (await db.get('SELECT account_id FROM suspensions WHERE account_id = ?', [accountId])) !== undefined;
}

/**
 * Refuses the account when it is suspended, for what a suspended account cannot do in any group: it is refused by the rule
 * `AccountSuspended`, and nothing changes. It is checked inside the write transaction of what it refuses, so a suspension
 * made meanwhile is seen.
 */
export async function refuseIfSuspended(db: Queryable, accountId: string): Promise<void> {
  if (await isSuspended(db, accountId)) {
    throw new Refusal(403, 'AccountSuspended', 'The account is suspended until an administrator reinstates it.');
  }
}

/**
 * An administrator suspends the account, or reinstates it. Suspending an account already suspended, or reinstating one that
 * is not, changes nothing and writes no entry. Otherwise the suspension is written and each change is kept in the
 * administrators' log, in the same write transaction. Nothing in any group is written. Anyone else is refused with
 * `NotAllowed`; an account that does not exist is `NotFound`.
 */
export async function setSuspension(
  db: Database,
  adminId: string,
  adminEmails: ReadonlySet<string>,
  accountId: string,
  suspended: boolean,
): Promise<void> {
  await db.transaction(async tx => {
    await refuseUnlessAdministrator(tx, adminId, adminEmails);
    if (!(await findAccount(tx, accountId))) throw new Refusal(404, 'NotFound', 'There is no such account.');
    if ((await isSuspended(tx, accountId)) === suspended) return;
    const at = new Date().toISOString();
    if (suspended) {
      await tx.run('INSERT INTO suspensions (account_id, suspended_at) VALUES (?, ?)', [accountId, at]);
    } else {
      await tx.run('DELETE FROM suspensions WHERE account_id = ?', [accountId]);
    }
    await writeAdminLog(tx, { by: adminId, action: suspended ? 'suspended' : 'reinstated', subjectId: accountId, at });
  });
}

export function registerSuspensionRoutes(app: FastifyInstance, db: Database, adminEmails: ReadonlySet<string>): void {
  app.put<{ Params: { id: string } }>('/admin/accounts/:id/suspension', async (request, reply) => {
    await setSuspension(db, await requireCaller(db, request), adminEmails, request.params.id, true);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/admin/accounts/:id/suspension', async (request, reply) => {
    await setSuspension(db, await requireCaller(db, request), adminEmails, request.params.id, false);
    return reply.code(204).send();
  });
}
