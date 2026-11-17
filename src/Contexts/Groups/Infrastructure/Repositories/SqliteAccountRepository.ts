import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { IAccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';

/** The table of accounts: one row per account, its email unique across all of them. */
export function createAccountsTable(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      version INTEGER NOT NULL
    );
  `);
}

interface AccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  version: number;
}

/**
 * The accounts as aggregates, over the application's SQLite file. Used inside the transaction of the command
 * that asks for it, which holds the file, so its statements are part of that transaction.
 */
export class SqliteAccountRepository implements IAccountRepository {
  constructor(private database: SqliteDatabase) {
    createAccountsTable(database);
  }

  async findById(id: string): Promise<Account | null> {
    const row = this.database.connection.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      AccountRow | undefined;
    return row ? Account.fromSnapshot(toSnapshot(row)) : null;
  }

  async findByEmail(email: Email): Promise<Account | null> {
    const row = this.database.connection.prepare('SELECT * FROM accounts WHERE email = ?').get(email.value) as
      AccountRow | undefined;
    return row ? Account.fromSnapshot(toSnapshot(row)) : null;
  }

  /**
   * The optimistic check as SQL makes it atomic: the update applies only to the row still at the version the
   * account was read at; no row changed means another writer got there first (ADR 8). A new account is inserted
   * at version 1.
   */
  async save(account: Account): Promise<IResult> {
    const snapshot = account.toSnapshot();
    const { _id: id, email, name, passwordHash, version } = snapshot;

    const updated = this.database.connection
      .prepare(
        `UPDATE accounts SET email = :email, name = :name, password_hash = :password_hash, version = :next
         WHERE id = :id AND version = :version`,
      )
      .run({ id, email, name, password_hash: passwordHash, version, next: version + 1 });
    if (updated.changes > 0) return Result.ok();

    const stored = this.database.connection.prepare('SELECT version FROM accounts WHERE id = ?').get(id);
    if (stored) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The account changed since it was read', { id }));
    }

    this.database.connection
      .prepare('INSERT INTO accounts (id, email, name, password_hash, version) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, name, passwordHash, version + 1);
    return Result.ok();
  }
}

function toSnapshot(row: AccountRow): IAccountSnapshot {
  return {
    _id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    version: row.version,
  };
}
