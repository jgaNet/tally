import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IAccountCredentials } from '@Contexts/Groups/Application/Ports/IAccountCredentials';
import { IAccountQueries } from '@Contexts/Groups/Application/Ports/IAccountQueries';
import { AccountReadModel } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';
import { CredentialsReadModel } from '@Contexts/Groups/Application/ReadModel/CredentialsReadModel';
import { createAccountsTable } from '@Contexts/Groups/Infrastructure/AccountsTable';

/** What is read of the accounts outside any command's transaction: it waits for the one in progress, if any. */
export class PostgresAccountReadModels implements IAccountQueries, IAccountCredentials {
  constructor(private database: PostgresDatabase) {
    createAccountsTable(database);
  }

  async findById(id: string): Promise<AccountReadModel | null> {
    const row = await this.database.exclusive(
      async () =>
        await this.database.get<AccountReadModel>(
          'SELECT id, email, name FROM accounts WHERE id = ? AND deleted_at IS NULL',
          id,
        ),
    );
    return row ?? null;
  }

  async isDeleted(id: string): Promise<boolean> {
    const row = await this.database.exclusive(
      async () =>
        await this.database.get<{ deleted_at: string | null }>('SELECT deleted_at FROM accounts WHERE id = ?', id),
    );
    return row?.deleted_at != null;
  }

  async findByEmail(email: string): Promise<CredentialsReadModel | null> {
    const row = await this.database.exclusive(
      async () =>
        await this.database.get<{ id: string; password_hash: string }>(
          'SELECT id, password_hash FROM accounts WHERE email = ?',
          email,
        ),
    );
    return row ? { accountId: row.id, passwordHash: row.password_hash } : null;
  }
}
