import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { EmailAlreadyUsed } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { ACCOUNT_STATEMENTS } from '@Contexts/Groups/Infrastructure/accounts.schema';

interface AccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  version: number;
}

/** The accounts' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqliteAccountRepository implements IAccountRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(ACCOUNT_STATEMENTS);
  }

  async findById(id: Id): Promise<Account | null> {
    return this.read('SELECT * FROM accounts WHERE id = ?', id.value);
  }

  async findByEmail(email: Email): Promise<Account | null> {
    return this.read('SELECT * FROM accounts WHERE email = ?', email.value);
  }

  async save(account: Account): Promise<IResult> {
    const { id, email, name, passwordHash, version } = account.toSnapshot();
    const { connection } = this.database;
    try {
      if (version === 0) {
        connection
          .prepare('INSERT INTO accounts (id, email, name, password_hash, version) VALUES (?, ?, ?, ?, 1)')
          .run(id, email, name, passwordHash);
      } else {
        const { changes } = connection
          .prepare(
            'UPDATE accounts SET name = ?, password_hash = ?, version = version + 1 WHERE id = ? AND version = ?',
          )
          .run(name, passwordHash, id, version);
        if (changes === 0) {
          return Result.fail(
            new ConcurrencyConflictException('Groups', 'The account changed since it was read', { id }),
          );
        }
      }
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: accounts.email/.test(error.message)) {
        return Result.fail(new EmailAlreadyUsed());
      }
      throw error;
    }
    return Result.ok();
  }

  private read(sql: string, parameter: string): Account | null {
    const row = this.database.connection.prepare(sql).get(parameter) as AccountRow | undefined;
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
