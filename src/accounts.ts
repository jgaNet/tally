import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isUniqueViolation, type Database, type Querier } from './database';
import { characters } from './text';
import { hashPassword, verifyPassword } from './passwords';
import { Refusal } from './refusal';
import { inTransaction } from './transactions';

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

/** The name a deleted account has, wherever its name is read: its own name is erased. */
export const DELETED_ACCOUNT_NAME = 'Deleted account';

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
export async function signUp(db: Querier, input: { email: string; password: string; name: string }): Promise<string> {
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
    await db
      .prepare('INSERT INTO accounts (id, email, email_key, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, email, email.toLowerCase(), trimmedName, passwordHash, new Date().toISOString());
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
export async function logIn(db: Querier, input: { email: string; password: string }): Promise<string> {
  const row = await db
    .prepare('SELECT id, email, name, password_hash FROM accounts WHERE email_key = ? AND deleted_at IS NULL')
    .get<AccountRow>(input.email.toLowerCase());
  const matches = await verifyPassword(input.password, row?.password_hash ?? NO_ACCOUNT_PASSWORD_HASH);
  if (!row || !matches) {
    throw new Refusal(401, 'CredentialsAreWrong', 'The email or the password is wrong.');
  }

  const token = randomBytes(32).toString('base64url');
  await db
    .prepare('INSERT INTO sessions (token_hash, account_id, created_at) VALUES (?, ?, ?)')
    .run(hashToken(token), row.id, new Date().toISOString());
  return token;
}

/** The account a token belongs to, or `undefined` when the token proves nothing. */
export async function accountForToken(db: Querier, token: string): Promise<Account | undefined> {
  const row = await db
    .prepare(
      'SELECT a.id, a.email, a.name FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND a.deleted_at IS NULL',
    )
    .get<Omit<AccountRow, 'password_hash'>>(hashToken(token));
  return row && { id: row.id, email: row.email, name: row.name };
}

/** The account with this id, or `undefined`. A deleted account is no account any more. */
export async function findAccount(db: Querier, id: string): Promise<Account | undefined> {
  const row = await db
    .prepare('SELECT id, email, name FROM accounts WHERE id = ? AND deleted_at IS NULL')
    .get<Omit<AccountRow, 'password_hash'>>(id);
  return row && { id: row.id, email: row.email, name: row.name };
}

/**
 * Whether the account was deleted by its person (see {@link deleteAccount}). A deleted account is still a member of the
 * groups it was in, with its balance; it cannot be put in a new split, paid through the provider, or netted with.
 */
export async function isDeleted(db: Querier, accountId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NOT NULL').get(accountId);
  return row !== undefined;
}

/** The ids, among `accountIds`, of the accounts that were deleted. */
export async function deletedAmong(db: Querier, accountIds: readonly string[]): Promise<Set<string>> {
  const deleted = new Set<string>();
  for (const accountId of new Set(accountIds)) {
    if (await isDeleted(db, accountId)) deleted.add(accountId);
  }
  return deleted;
}

/**
 * Refuses a change that names a deleted account as the other party, `422` as `AccountIsDeleted`. Each such change calls it
 * before it writes anything.
 */
export async function assertNotDeleted(db: Querier, accountId: string): Promise<void> {
  if (await isDeleted(db, accountId)) {
    throw new Refusal(422, 'AccountIsDeleted', 'The account was deleted: it cannot be the other party of this change.');
  }
}

/**
 * Deletes the account `accountId` at the request of its person. Refused with `409` as `GroupHasOtherMembers` while the
 * account owns a group that has another current member, and with `409` as `SettlementIsInProgress` while a settlement
 * through the provider that it pays or receives is `pending`, `refunding` or `contested`: nothing changes then.
 *
 * Otherwise the account is erased, in one transaction: its name becomes {@link DELETED_ACCOUNT_NAME}, its email and password
 * are erased and its email is free again, its sessions end, and its payout account is removed. Its id stays where it is: in the
 * groups (where it stays a member, with its balance), the expenses, the settlements, the audit and the administrators' log.
 */
export async function deleteAccount(db: Database, input: { accountId: string }): Promise<void> {
  const { accountId } = input;
  await inTransaction(db, async tx => {
    const owned = await tx
      .prepare(
        `SELECT 1 FROM group_members m
         WHERE m.group_id IN (SELECT id FROM groups WHERE owner_id = ?) AND m.account_id <> ? AND m.left_at IS NULL`,
      )
      .get(accountId, accountId);
    if (owned !== undefined) {
      throw new Refusal(
        409,
        'GroupHasOtherMembers',
        'The account owns a group that has other members: they must leave it before the account is deleted.',
      );
    }
    const waiting = await tx
      .prepare(
        `SELECT 1 FROM settlements
         WHERE method = 'provider' AND status IN ('pending', 'refunding', 'contested')
           AND (payer_id = ? OR payee_id = ?)`,
      )
      .get(accountId, accountId);
    if (waiting !== undefined) {
      throw new Refusal(
        409,
        'SettlementIsInProgress',
        'A settlement through the provider that the account pays or receives has not ended yet.',
      );
    }
    await tx.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
    await tx.prepare('DELETE FROM payout_accounts WHERE account_id = ?').run(accountId);
    // The email key is the id, which no email can be: the email it had is free for a new account.
    await tx
      .prepare(
        `UPDATE accounts SET email = '', email_key = 'deleted:' || id, name = ?, password_hash = '', deleted_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(DELETED_ACCOUNT_NAME, new Date().toISOString(), accountId);
  });
}
