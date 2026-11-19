import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IAccountQueries } from '@Contexts/Groups/Application/Ports/IAccountQueries';
import { AccountCredentials, AccountReadModel } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';
import { ACCOUNT_STATEMENTS } from '@Contexts/Groups/Infrastructure/accounts.schema';

/** What the screens and the sign-in read of the accounts, from the PostgreSQL database, outside any transaction. */
export class PostgresAccountQueries implements IAccountQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(ACCOUNT_STATEMENTS);
  }

  async findById(id: string): Promise<AccountReadModel | null> {
    const row = await this.database.exclusive(connection =>
      connection.row<AccountReadModel>('SELECT id, email, name FROM accounts WHERE id = ?', id),
    );
    return row ?? null;
  }

  async isDeleted(id: string): Promise<boolean> {
    const row = await this.database.exclusive(connection =>
      connection.row('SELECT 1 AS found FROM accounts WHERE id = ? AND deleted_at IS NOT NULL', id),
    );
    return row !== undefined;
  }

  async findCredentials(email: string): Promise<AccountCredentials | null> {
    const row = await this.database.exclusive(connection =>
      connection.row<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM accounts WHERE email = ?',
        email.trim().toLowerCase(),
      ),
    );
    return row ? { id: row.id, passwordHash: row.password_hash } : null;
  }
}
