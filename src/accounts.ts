import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
import { hashPassword, verifyPassword } from './credentials';
import { Refusal } from './refusal';
import { issueSession, requireCaller } from './sessions';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;
const NAME_MAX = 60;

export interface Account {
  id: string;
  email: string;
  name: string;
}

export interface SignUp {
  email: string;
  password: string;
  name: string;
}

export interface SignIn {
  email: string;
  password: string;
}

/** Emails are kept lowercase, so an email is one account whatever its case. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function length(text: string): number {
  return Array.from(text).length;
}

/** Creates the account and returns its id. A refused sign-up is a `Refusal`. */
export async function signUp(db: Queryable, input: SignUp): Promise<string> {
  const email = normalizeEmail(input.email);
  if (!EMAIL_SHAPE.test(email)) throw new Refusal(422, 'InvalidEmail', 'The email does not look like one.');
  if (length(input.password) < PASSWORD_MIN) {
    throw new Refusal(422, 'PasswordTooShort', `The password needs at least ${PASSWORD_MIN} characters.`);
  }
  const name = input.name.trim();
  if (length(name) < 1 || length(name) > NAME_MAX) {
    throw new Refusal(422, 'InvalidName', `The name needs 1 to ${NAME_MAX} characters and cannot be only spaces.`);
  }
  const id = randomUUID();
  const passwordHash = await hashPassword(input.password);
  // The unique index on email decides between two sign-ups of one email, even across servers.
  const inserted = await db.run(
    'INSERT INTO accounts (id, email, name, password_hash) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING',
    [id, email, name, passwordHash],
  );
  if (inserted.changes === 0) throw new Refusal(409, 'EmailTaken', 'An account already uses this email.');
  return id;
}

let unknownAccountHash: Promise<string> | undefined;

/**
 * Returns a bearer token when the email and password match an account. An unknown email and a wrong
 * password are refused alike, and both take the time of a password check, so the answer does not
 * reveal which emails have accounts.
 */
export async function signIn(db: Database, input: SignIn): Promise<string> {
  const row = await db.get<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM accounts WHERE email = ?',
    [normalizeEmail(input.email)],
  );
  unknownAccountHash ??= hashPassword('no account has this password');
  const matches = await verifyPassword(input.password, row ? row.password_hash : await unknownAccountHash);
  if (!row || !matches) throw new Refusal(401, 'InvalidCredentials', 'The email or the password is wrong.');
  return issueSession(db, row.id);
}

/** Whether the account was deleted: its person is gone, and it stays only as an id in what the groups hold. */
export async function isDeleted(db: Queryable, accountId: string): Promise<boolean> {
  return (await db.get('SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NOT NULL', [accountId])) !== undefined;
}

/** The account, when it exists and was not deleted: a deleted account is as if no account had its id. */
export async function findAccount(db: Queryable, id: string): Promise<Account | undefined> {
  return db.get<Account>('SELECT id, email, name FROM accounts WHERE id = ? AND deleted_at IS NULL', [id]);
}

/**
 * Deletes the account of the caller. Refused, and nothing changes, while the account owns a group that has another
 * member (`OwnsGroupWithMembers`), or while a payment or a refund through the provider it pays or receives is pending,
 * refunding or contested (`SettlementWaiting`). Otherwise, in one write transaction: its tokens are dropped, its payout
 * account is removed, and its name is erased, with its email and password hash, so no one signs in with them again.
 * Its id stays where it is, in the groups' members, the expenses, the settlements, the audit and the administrators' log;
 * it stays a member of each group it was in, with its balance, which the members list names `Deleted account`.
 */
export async function deleteAccount(db: Database, accountId: string): Promise<void> {
  await db.transaction(async tx => {
    const ownsOthers = await tx.get(
      `SELECT 1 FROM groups g JOIN group_members m ON m.group_id = g.id AND m.left_at IS NULL AND m.account_id <> g.owner_id
       WHERE g.owner_id = ?`,
      [accountId],
    );
    if (ownsOthers) {
      throw new Refusal(
        409,
        'OwnsGroupWithMembers',
        'The account owns a group that has other members, so it cannot be deleted.',
      );
    }
    const waiting = await tx.get(
      `SELECT 1 FROM settlements WHERE method = 'provider' AND status IN ('pending', 'refunding', 'contested')
         AND (payer_id = ? OR payee_id = ?)`,
      [accountId, accountId],
    );
    if (waiting) {
      throw new Refusal(
        409,
        'SettlementWaiting',
        'A payment or a refund through the provider is still waiting for the account.',
      );
    }
    await tx.run('DELETE FROM sessions WHERE account_id = ?', [accountId]);
    await tx.run('DELETE FROM payout_accounts WHERE account_id = ?', [accountId]);
    await tx.run(
      "UPDATE accounts SET name = 'Deleted account', email = NULL, password_hash = NULL, deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
      [new Date().toISOString(), accountId],
    );
  });
}

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const accountSchema = {
  type: 'object',
  required: ['id', 'email', 'name'],
  properties: { id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } },
};

const stringBody = (fields: string[]) => ({
  type: 'object',
  required: fields,
  properties: Object.fromEntries(fields.map(field => [field, { type: 'string' }])),
});

export function registerAccountRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Body: SignUp }>(
    '/accounts',
    { schema: { body: stringBody(['email', 'password', 'name']), response: { 201: idSchema } } },
    async (request, reply) => {
      const id = await signUp(db, request.body);
      return reply.code(201).send({ id });
    },
  );

  app.post<{ Body: SignIn }>(
    '/accounts/login',
    {
      schema: {
        body: stringBody(['email', 'password']),
        response: { 200: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } },
      },
    },
    async request => ({ token: await signIn(db, request.body) }),
  );

  app.get('/accounts/me', { schema: { response: { 200: accountSchema } } }, async request => {
    const id = await requireCaller(db, request);
    const account = await findAccount(db, id);
    if (!account) throw new Refusal(401, 'Unauthorized', 'The signed-in account no longer exists.');
    return account;
  });

  app.delete('/accounts/me', async (request, reply) => {
    await deleteAccount(db, await requireCaller(db, request));
    return reply.code(204).send();
  });
}
