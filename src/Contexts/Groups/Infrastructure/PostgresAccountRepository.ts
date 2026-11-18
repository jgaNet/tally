import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { EmailAlreadyUsedException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/** The accounts' table: the email is unique, so two sign-ups of one email cannot both be stored, whichever process made them. */
export const ACCOUNTS_SCHEMA =
  'CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, suspended BOOLEAN NOT NULL DEFAULT FALSE, version INTEGER NOT NULL)';

/**
 * The administrators' log of the changes to accounts, one row each, never changed, written with the change (request 34, docs/adr/0034).
 * `seq` orders it, the oldest first.
 */
export const ADMINISTRATOR_CHANGES_SCHEMA =
  'CREATE TABLE IF NOT EXISTS administrator_account_changes (seq BIGSERIAL NOT NULL UNIQUE, id TEXT PRIMARY KEY, at TEXT NOT NULL, by_id TEXT NOT NULL, action TEXT NOT NULL, subject_id TEXT NOT NULL)';

/** The accounts' schema steps, run once when the database is prepared (docs/adr/0029). */
export async function prepareAccountsSchema(database: PostgresDatabase): Promise<void> {
  await database.exec(ACCOUNTS_SCHEMA);
  await database.exec(ADMINISTRATOR_CHANGES_SCHEMA);
}

/** The name PostgreSQL gives the UNIQUE constraint on `accounts.email`. */
const EMAIL_CONSTRAINT = 'accounts_email_key';

type AccountRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  suspended: boolean;
  version: number;
};

const toSnapshot = (row: AccountRow): AccountSnapshot => ({
  id: String(row.id),
  email: String(row.email),
  name: String(row.name),
  passwordHash: String(row.password_hash),
  suspended: row.suspended === true,
  version: Number(row.version),
});

/** A unique violation (SQLSTATE 23505) on the accounts' email: the one error a sign-up of a used email raises. */
function isEmailTaken(error: unknown): boolean {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === EMAIL_CONSTRAINT;
}

/** The accounts' store over PostgreSQL (docs/adr/0002). Its methods run inside a transaction: the use case's. */
export class PostgresAccountRepository implements IAccountRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareAccountsSchema);
  }

  async findById(id: string): Promise<Account | undefined> {
    return this.#one('id', id);
  }

  async findByEmail(email: string): Promise<Account | undefined> {
    return this.#one('email', email);
  }

  async save(account: Account): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = account.toSnapshot();
    try {
      if (snapshot.version === 0) {
        await this.database.run(
          'INSERT INTO accounts (id, email, name, password_hash, suspended, version) VALUES (?, ?, ?, ?, ?, ?)',
          [snapshot.id, snapshot.email, snapshot.name, snapshot.passwordHash, snapshot.suspended, snapshot.version + 1],
        );
      } else {
        const { changes } = await this.database.run(
          'UPDATE accounts SET email = ?, name = ?, password_hash = ?, suspended = ?, version = ? WHERE id = ? AND version = ?',
          [
            snapshot.email,
            snapshot.name,
            snapshot.passwordHash,
            snapshot.suspended,
            snapshot.version + 1,
            snapshot.id,
            snapshot.version,
          ],
        );
        if (changes === 0) {
          return Result.fail(new ConcurrencyConflictException('Groups', 'The account changed since it was read'));
        }
      }
    } catch (error) {
      if (isEmailTaken(error)) return Result.fail(new EmailAlreadyUsedException());
      throw error;
    }

    // Each administrators' change the account made is an entry of the log, written with it in this transaction (request 34, docs/adr/0034).
    for (const change of account.changes) {
      await this.database.run(
        'INSERT INTO administrator_account_changes (id, at, by_id, action, subject_id) VALUES (?, ?, ?, ?, ?)',
        [change.id, change.at, change.by, change.action, change.subjectId],
      );
    }
    return Result.ok(undefined);
  }

  async #one(column: 'id' | 'email', value: string): Promise<Account | undefined> {
    this.database.assertInTransaction();
    const row = await this.database.get<AccountRow>(
      `SELECT id, email, name, password_hash, suspended, version FROM accounts WHERE ${column} = ?`,
      [value],
    );
    return row ? Account.fromSnapshot(toSnapshot(row)) : undefined;
  }
}
