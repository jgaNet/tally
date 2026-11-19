import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type Database, inTransaction } from '../database';
import { Refusal } from '../refusal';
import { DECOY_PASSWORD_HASH, hashPassword, verifyPassword } from './passwords';
import { emailKey, validateSignup } from './validation';

export interface Account {
  id: string;
  email: string;
  name: string;
}

interface AccountRow {
  id: string;
  email: string;
  name: string;
  password_salt: string;
  password_hash: string;
}

/** The name a deleted account is left with: its own name is erased. It is what the members of its groups are shown. */
export const DELETED_ACCOUNT_NAME = 'Deleted account';

/** PostgreSQL's unique_violation: a row with the same key is already there. */
const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Creates an account. An email already used, in any case, is refused with `409`. */
export async function createAccount(
  db: Database,
  input: { email: string; password: string; name: string },
): Promise<string> {
  const signup = validateSignup(input);
  const password = await hashPassword(signup.password);
  const id = randomUUID();
  try {
    await db.execute(
      `INSERT INTO accounts (id, email, email_key, name, password_salt, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, signup.email, emailKey(signup.email), signup.name, password.salt, password.hash, new Date().toISOString()],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Refusal(409, 'EmailTaken', 'An account already uses this email.');
    }
    throw error;
  }
  return id;
}

const INVALID_CREDENTIALS = 'The email or the password is wrong.';

/**
 * Signs in. A wrong password and an email no account has are refused the same way, and take the
 * same time, so nobody learns which emails have accounts.
 */
export async function login(db: Database, input: { email: string; password: string }): Promise<string> {
  const row = await db.row<AccountRow>(
    'SELECT id, email, name, password_salt, password_hash FROM accounts WHERE email_key = ? AND deleted_at IS NULL',
    [emailKey(input.email.trim())],
  );

  if (!row) {
    // Spend the same time a real check would, then refuse.
    await verifyPassword(input.password, await DECOY_PASSWORD_HASH);
    throw new Refusal(401, 'InvalidCredentials', INVALID_CREDENTIALS);
  }
  const matches = await verifyPassword(input.password, { salt: row.password_salt, hash: row.password_hash });
  if (!matches) {
    throw new Refusal(401, 'InvalidCredentials', INVALID_CREDENTIALS);
  }

  const token = randomBytes(32).toString('base64url');
  await db.execute('INSERT INTO sessions (token_hash, account_id, created_at) VALUES (?, ?, ?)', [
    sha256(token),
    row.id,
    new Date().toISOString(),
  ]);
  return token;
}

/** The account a token belongs to, or `undefined` when the token proves nothing, a deleted account's included. */
export function accountForToken(db: Database, token: string): Promise<Account | undefined> {
  return db.row<Account>(
    `SELECT accounts.id, accounts.email, accounts.name
       FROM sessions JOIN accounts ON accounts.id = sessions.account_id
      WHERE sessions.token_hash = ? AND accounts.deleted_at IS NULL`,
    [sha256(token)],
  );
}

/** Whether `accountId` is a deleted account. Reading it changes nothing. */
export async function isDeleted(db: Database, accountId: string): Promise<boolean> {
  const row = await db.row<{ deleted_at: string | null }>('SELECT deleted_at FROM accounts WHERE id = ?', [accountId]);
  return row?.deleted_at != null;
}

/**
 * Deletes the account `accountId`, which deletes itself. It is refused with `409` `OwnsGroupWithMembers` while it owns a
 * group that has another member, and with `409` `PaymentPending` while a settlement it pays or receives through the
 * provider is pending, refunding or contested; nothing changes then. Otherwise its name and email are erased, its
 * password is gone, its sessions end, and it leaves no suspension, payout account or debt note; its id stays where it
 * is, so its balances and its groups still add up. Its email is free for a new account. Written in one transaction.
 */
export function deleteAccount(db: Database, accountId: string, at: Date): Promise<void> {
  return inTransaction(db, async () => {
    const ownsGroupWithMembers = await db.row(
      `SELECT 1 FROM groups
         JOIN memberships ON memberships.group_id = groups.id AND memberships.account_id <> groups.owner_id
        WHERE groups.owner_id = ?`,
      [accountId],
    );
    if (ownsGroupWithMembers) {
      throw new Refusal(
        409,
        'OwnsGroupWithMembers',
        'The account owns a group that has other members: the group must have no member but its owner first.',
      );
    }
    const waiting = await db.row(
      `SELECT 1 FROM settlements
        WHERE method = 'provider' AND status IN ('pending', 'refunding', 'contested') AND (payer_id = ? OR payee_id = ?)`,
      [accountId, accountId],
    );
    if (waiting) {
      throw new Refusal(
        409,
        'PaymentPending',
        'A payment or a refund through the provider is waiting for you, or a payment of yours is contested: it must end first.',
      );
    }
    await db.execute('DELETE FROM sessions WHERE account_id = ?', [accountId]);
    await db.execute('DELETE FROM payout_accounts WHERE account_id = ?', [accountId]);
    await db.execute('DELETE FROM suspensions WHERE account_id = ?', [accountId]);
    await db.execute('DELETE FROM noted_debts WHERE account_id = ?', [accountId]);
    // The email key is no email, so it is free, and no sign-in can match it: a deleted account has no password either.
    await db.execute(
      `UPDATE accounts SET email = '', email_key = ?, name = ?, password_salt = '', password_hash = '', deleted_at = ?
        WHERE id = ?`,
      [`deleted:${accountId}`, DELETED_ACCOUNT_NAME, at.toISOString(), accountId],
    );
  });
}
