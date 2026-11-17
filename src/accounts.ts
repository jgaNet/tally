import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isUniqueViolation } from './database';
import { characters } from './text';
import { hashPassword, verifyPassword } from './passwords';
import { Refusal } from './refusal';

/** What the application knows of an account, as its owner sees it. */
export interface Account {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

interface AccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 60;

/** A hash of a password nobody sends, checked against unknown emails so both cases cost the same. */
const NO_ACCOUNT_PASSWORD_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Creates an account and returns its id. The email must look like one and be unused whatever its
 * case; the password has at least 8 characters; the name has 1 to 60 characters and is not only
 * spaces (it is stored trimmed).
 */
export async function signUp(
  db: DatabaseSync,
  input: { email: string; password: string; name: string },
): Promise<string> {
  const { email, password, name } = input;
  if (!EMAIL_SHAPE.test(email)) {
    throw new Refusal(422, 'EmailIsInvalid', 'The email must look like an email address.');
  }
  if (characters(password) < MIN_PASSWORD_LENGTH) {
    throw new Refusal(422, 'PasswordIsTooShort', `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const trimmedName = name.trim();
  if (characters(name) > MAX_NAME_LENGTH || trimmedName.length === 0) {
    throw new Refusal(
      422,
      'NameIsInvalid',
      `The name must have 1 to ${MAX_NAME_LENGTH} characters and not be only spaces.`,
    );
  }

  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    db.prepare(
      'INSERT INTO accounts (id, email, email_key, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, email, email.toLowerCase(), trimmedName, passwordHash, new Date().toISOString());
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Refusal(409, 'EmailIsTaken', 'An account already uses this email.');
    }
    throw error;
  }
  return id;
}

/**
 * Signs in: checks the password and starts a session, answering its token. A wrong password and an
 * unknown email are refused with the same answer.
 */
export async function logIn(db: DatabaseSync, input: { email: string; password: string }): Promise<string> {
  const row = db
    .prepare('SELECT id, email, name, password_hash FROM accounts WHERE email_key = ?')
    .get(input.email.toLowerCase()) as AccountRow | undefined;
  const matches = await verifyPassword(input.password, row?.password_hash ?? NO_ACCOUNT_PASSWORD_HASH);
  if (!row || !matches) {
    throw new Refusal(401, 'CredentialsAreWrong', 'The email or the password is wrong.');
  }

  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, account_id, created_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    row.id,
    new Date().toISOString(),
  );
  return token;
}

/** The account a token belongs to, or `undefined` when the token proves nothing. */
export function accountForToken(db: DatabaseSync, token: string): Account | undefined {
  const row = db
    .prepare(
      'SELECT a.id, a.email, a.name FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?',
    )
    .get(hashToken(token)) as Omit<AccountRow, 'password_hash'> | undefined;
  return row && { id: row.id, email: row.email, name: row.name };
}

/** The account with this id, or `undefined`. */
export function findAccount(db: DatabaseSync, id: string): Account | undefined {
  const row = db.prepare('SELECT id, email, name FROM accounts WHERE id = ?').get(id) as
    Omit<AccountRow, 'password_hash'> | undefined;
  return row && { id: row.id, email: row.email, name: row.name };
}
