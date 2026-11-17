import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { EmailAlreadyUsedException } from '@Contexts/Groups/Domain/Account/AccountExceptions';

/** The accounts' table: the email is unique, so two sign-ups of one email cannot both be stored, whichever process made them. */
export const ACCOUNTS_SCHEMA =
  'CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, version INTEGER NOT NULL)';

type AccountRow = { id: string; email: string; name: string; password_hash: string; version: number };

const toSnapshot = (row: AccountRow): AccountSnapshot => ({
  id: String(row.id),
  email: String(row.email),
  name: String(row.name),
  passwordHash: String(row.password_hash),
  version: Number(row.version),
});

/** The accounts' store over SQLite (docs/adr/0002). Its methods run inside a transaction: the use case's. */
export class SqliteAccountRepository implements IAccountRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(ACCOUNTS_SCHEMA));
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
    const connection = this.database.connection;
    try {
      if (snapshot.version === 0) {
        connection
          .prepare('INSERT INTO accounts (id, email, name, password_hash, version) VALUES (?, ?, ?, ?, ?)')
          .run(snapshot.id, snapshot.email, snapshot.name, snapshot.passwordHash, snapshot.version + 1);
        return Result.ok(undefined);
      }
      const { changes } = connection
        .prepare('UPDATE accounts SET email = ?, name = ?, password_hash = ?, version = ? WHERE id = ? AND version = ?')
        .run(snapshot.email, snapshot.name, snapshot.passwordHash, snapshot.version + 1, snapshot.id, snapshot.version);
      if (changes === 0) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The account changed since it was read'));
      }
      return Result.ok(undefined);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: accounts.email')) {
        return Result.fail(new EmailAlreadyUsedException());
      }
      throw error;
    }
  }

  #one(column: 'id' | 'email', value: string): Account | undefined {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare(`SELECT id, email, name, password_hash, version FROM accounts WHERE ${column} = ?`)
      .get(value) as AccountRow | undefined;
    return row ? Account.fromSnapshot(toSnapshot(row)) : undefined;
  }
}
