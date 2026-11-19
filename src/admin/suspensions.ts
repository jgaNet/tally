import { type Database, inTransaction } from '../database';
import { Refusal } from '../refusal';
import { recordAdministratorEntry } from './log';

/** Whether `accountId` is suspended. Reading it changes nothing. */
export async function isSuspended(db: Database, accountId: string): Promise<boolean> {
  return (await db.row('SELECT 1 FROM suspensions WHERE account_id = ?', [accountId])) !== undefined;
}

/**
 * Refuses what a suspended account asks for: recording an expense, a recurring expense, a settlement in cash, a
 * payment through the provider, or a netting. It is the one rule all of them share, and it changes nothing. Called
 * inside the transaction of the request, so a suspension that lands first is seen.
 */
export async function requireNotSuspended(db: Database, accountId: string): Promise<void> {
  if (await isSuspended(db, accountId)) {
    throw new Refusal(409, 'AccountSuspended', 'The account is suspended until an administrator reinstates it.');
  }
}

/**
 * Suspends `accountId` at the request of the administrator `administratorId`. Suspending an account already suspended
 * changes nothing, and is no entry of the administrators' log; otherwise the suspension is logged as `suspended`. An
 * unknown account is refused with `404`. Written in one transaction, under the write lock.
 */
export function suspendAccount(db: Database, administratorId: string, accountId: string): Promise<void> {
  return inTransaction(db, async () => {
    await requireExistingAccount(db, accountId);
    const at = new Date().toISOString();
    const inserted = await db.execute(
      'INSERT INTO suspensions (account_id, suspended_at) VALUES (?, ?) ON CONFLICT (account_id) DO NOTHING',
      [accountId, at],
    );
    if (inserted === 1) {
      await recordAdministratorEntry(db, administratorId, 'suspended', accountId, at);
    }
  });
}

/**
 * Reinstates `accountId` at the request of the administrator `administratorId`. Reinstating an account that is not
 * suspended changes nothing, and is no entry of the administrators' log; otherwise it is logged as `reinstated`. An
 * unknown account is refused with `404`. Written in one transaction, under the write lock.
 */
export function reinstateAccount(db: Database, administratorId: string, accountId: string): Promise<void> {
  return inTransaction(db, async () => {
    await requireExistingAccount(db, accountId);
    const at = new Date().toISOString();
    const deleted = await db.execute('DELETE FROM suspensions WHERE account_id = ?', [accountId]);
    if (deleted === 1) {
      await recordAdministratorEntry(db, administratorId, 'reinstated', accountId, at);
    }
  });
}

async function requireExistingAccount(db: Database, accountId: string): Promise<void> {
  if ((await db.row('SELECT 1 FROM accounts WHERE id = ?', [accountId])) === undefined) {
    throw new Refusal(404, 'NotFound', 'There is no such account.');
  }
}
