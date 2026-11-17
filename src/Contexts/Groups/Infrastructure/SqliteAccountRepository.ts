import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { EmailAlreadyUsed } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { createAccountsTable } from '@Contexts/Groups/Infrastructure/AccountsTable';

interface Row {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  version: number;
}

/**
 * The accounts the sign-up decides with, in the application's file. It runs inside the command's transaction,
 * which holds the file, so it takes no lock of its own. The email is unique in the file itself, so that two
 * sign-ups at once, on one server or two, cannot both win.
 */
export class SqliteAccountRepository implements IAccountRepository {
  constructor(private database: SqliteDatabase) {
    createAccountsTable(database);
  }

  async findById(id: Id): Promise<Account | null> {
    return this.one(this.database.get<Row>('SELECT * FROM accounts WHERE id = ?', id.value));
  }

  async findByEmail(email: Email): Promise<Account | null> {
    return this.one(this.database.get<Row>('SELECT * FROM accounts WHERE email = ?', email.value));
  }

  async save(account: Account): Promise<IResult> {
    const { id, email, name, passwordHash, version } = account.toSnapshot();
    try {
      if (version === 0) {
        this.database.run(
          'INSERT INTO accounts (id, email, name, password_hash, version) VALUES (?, ?, ?, ?, ?)',
          id,
          email,
          name,
          passwordHash,
          1,
        );
      } else {
        const changed = this.database.run(
          'UPDATE accounts SET email = ?, name = ?, password_hash = ?, version = ? WHERE id = ? AND version = ?',
          email,
          name,
          passwordHash,
          version + 1,
          id,
          version,
        );
        if (!changed) return Result.fail(new ConcurrencyConflictException('Groups', 'The account has changed', { id }));
      }
      return Result.ok();
    } catch (error) {
      if (/UNIQUE constraint failed/.test(String((error as Error).message))) return Result.fail(new EmailAlreadyUsed());
      throw error;
    }
  }

  private one(row: Row | undefined): Account | null {
    return row
      ? Account.fromSnapshot({
          id: row.id,
          email: row.email,
          name: row.name,
          passwordHash: row.password_hash,
          version: row.version,
        })
      : null;
  }
}
