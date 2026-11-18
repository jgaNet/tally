import { findAccount } from './accounts';
import { recordAdminLog } from './admin-log';
import type { Database, Querier } from './database';
import { Refusal } from './refusal';
import { inTransaction } from './transactions';

/**
 * Whether an administrator has suspended the account. A suspended account cannot record an expense, set up a recurring
 * expense, record a settlement in cash, ask to pay through the provider, or ask for a netting, in any group, until it is
 * reinstated (see {@link assertNotSuspended}). Everything else it does is as before, and a suspension changes nothing in
 * any group.
 */
export async function isSuspended(db: Querier, accountId: string): Promise<boolean> {
  const row = await db.prepare('SELECT account_id FROM suspensions WHERE account_id = ?').get(accountId);
  return row !== undefined;
}

/**
 * Refuses a change a suspended account cannot make, `403` as `AccountIsSuspended`, the same for each such change. Each
 * of them calls it inside its own transaction, before it writes anything, so a refused change changes nothing.
 */
export async function assertNotSuspended(db: Querier, accountId: string): Promise<void> {
  if (await isSuspended(db, accountId)) {
    throw new Refusal(
      403,
      'AccountIsSuspended',
      'The account is suspended until it is reinstated: it cannot make this change.',
    );
  }
}

/**
 * Suspends the account, as the administrator `administratorId`. An account already suspended changes nothing, and enters
 * no log entry. Refused with `404` when no account has this id. The suspension and its log entry are written in one
 * transaction, so the entry exists exactly when the suspension does.
 */
export async function suspendAccount(
  db: Database,
  input: { accountId: string; administratorId: string },
): Promise<void> {
  const at = new Date().toISOString();
  await inTransaction(db, async tx => {
    if (!(await findAccount(tx, input.accountId))) {
      throw new Refusal(404, 'AccountNotFound', 'No account has this id.');
    }
    const { changes } = await tx
      .prepare('INSERT INTO suspensions (account_id, suspended_at) VALUES (?, ?) ON CONFLICT (account_id) DO NOTHING')
      .run(input.accountId, at);
    if (changes === 1) {
      await recordAdminLog(tx, {
        at,
        by: input.administratorId,
        action: 'suspended',
        subjectId: input.accountId,
      });
    }
  });
}

/**
 * Reinstates the account, as the administrator `administratorId`. An account not suspended changes nothing, and enters no
 * log entry. Refused with `404` when no account has this id. The reinstatement and its log entry are written in one
 * transaction.
 */
export async function reinstateAccount(
  db: Database,
  input: { accountId: string; administratorId: string },
): Promise<void> {
  const at = new Date().toISOString();
  await inTransaction(db, async tx => {
    if (!(await findAccount(tx, input.accountId))) {
      throw new Refusal(404, 'AccountNotFound', 'No account has this id.');
    }
    const { changes } = await tx.prepare('DELETE FROM suspensions WHERE account_id = ?').run(input.accountId);
    if (changes === 1) {
      await recordAdminLog(tx, {
        at,
        by: input.administratorId,
        action: 'reinstated',
        subjectId: input.accountId,
      });
    }
  });
}
