import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '../database';
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
    'SELECT id, email, name, password_salt, password_hash FROM accounts WHERE email_key = ?',
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

/** The account a token belongs to, or `undefined` when the token proves nothing. */
export function accountForToken(db: Database, token: string): Promise<Account | undefined> {
  return db.row<Account>(
    `SELECT accounts.id, accounts.email, accounts.name
       FROM sessions JOIN accounts ON accounts.id = sessions.account_id
      WHERE sessions.token_hash = ?`,
    [sha256(token)],
  );
}
