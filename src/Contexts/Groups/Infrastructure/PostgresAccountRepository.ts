import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
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
  suspended_at: string | null;
}

/** The accounts' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresAccountRepository implements IAccountRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(ACCOUNT_STATEMENTS);
  }

  async findById(id: Id): Promise<Account | null> {
    return this.read('SELECT * FROM accounts WHERE id = ?', id.value);
  }

  async findByEmail(email: Email): Promise<Account | null> {
    return this.read('SELECT * FROM accounts WHERE email = ?', email.value);
  }

  async save(account: Account): Promise<IResult> {
    const { id, email, name, passwordHash, version, suspendedAt } = account.toSnapshot();
    const { connection } = this.database;
    if (version === 0) {
      // The email's uniqueness is decided on committed state (the write lock, ADR 22), and the UNIQUE index backs it.
      const { changes } = await connection.run(
        'INSERT INTO accounts (id, email, name, password_hash, version) VALUES (?, ?, ?, ?, 1) ON CONFLICT (email) DO NOTHING',
        id,
        email,
        name,
        passwordHash,
      );
      return changes === 0 ? Result.fail(new EmailAlreadyUsed()) : Result.ok();
    }
    const { changes } = await connection.run(
      'UPDATE accounts SET name = ?, password_hash = ?, suspended_at = ?, version = version + 1 WHERE id = ? AND version = ?',
      name,
      passwordHash,
      suspendedAt ?? null,
      id,
      version,
    );
    if (changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The account changed since it was read', { id }));
    }
    return Result.ok();
  }

  private async read(sql: string, parameter: string): Promise<Account | null> {
    const row = await this.database.connection.row<AccountRow>(sql, parameter);
    return row
      ? Account.fromSnapshot({
          id: row.id,
          email: row.email,
          name: row.name,
          passwordHash: row.password_hash,
          version: row.version,
          suspendedAt: row.suspended_at,
        })
      : null;
  }
}
