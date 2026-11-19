import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { EmailAlreadyUsed } from '@Contexts/Groups/Domain/Account/AccountExceptions';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { ACCOUNT_STATEMENTS } from '@Contexts/Groups/Infrastructure/accounts.schema';

interface AccountRow {
  id: string;
  email: string | null;
  name: string;
  password_hash: string;
  version: number;
  suspended_at: string | null;
  deleted_at: string | null;
}

/** The accounts' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresAccountRepository implements IAccountRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(PostgresOutbox.STATEMENTS);
    database.migrate(ACCOUNT_STATEMENTS);
  }

  async findById(id: Id): Promise<Account | null> {
    return this.read('SELECT * FROM accounts WHERE id = ?', id.value);
  }

  async findByEmail(email: Email): Promise<Account | null> {
    return this.read('SELECT * FROM accounts WHERE email = ?', email.value);
  }

  async save(account: Account): Promise<IResult> {
    const { id, email, name, passwordHash, version, suspendedAt, deletedAt } = account.toSnapshot();
    const { connection } = this.database;
    if (version === 0 && email !== null) {
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
      'UPDATE accounts SET email = ?, name = ?, password_hash = ?, suspended_at = ?, deleted_at = ?, version = version + 1 WHERE id = ? AND version = ?',
      email,
      name,
      passwordHash,
      suspendedAt ?? null,
      deletedAt ?? null,
      id,
      version,
    );
    if (changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The account changed since it was read', { id }));
    }
    // A deleted account is erased from the facts Groups kept of it, in the same transaction (request 35): AccountRegistered, which
    // an outbox not yet relayed still holds, carries its email and its name.
    if (deletedAt) await this.erasePastFacts(id);
    return Result.ok();
  }

  /** Erases the name and the email from the account's fact still waiting in the outbox; the id and the fact stay. */
  private async erasePastFacts(accountId: string): Promise<void> {
    await this.database.connection.run(
      `UPDATE outbox
          SET payload = ((payload::jsonb - 'email' - 'name') || '{"email":"","name":"Deleted account"}'::jsonb)::text
        WHERE name = 'AccountRegisteredEvent' AND payload::jsonb ->> 'accountId' = ?`,
      accountId,
    );
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
          deletedAt: row.deleted_at,
        })
      : null;
  }
}
