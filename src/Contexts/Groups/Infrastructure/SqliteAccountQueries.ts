import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IAccountQueries } from '@Contexts/Groups/Application/Ports/IAccountQueries';
import { AccountCredentials, AccountReadModel } from '@Contexts/Groups/Application/ReadModel/AccountReadModel';
import { ACCOUNT_STATEMENTS } from '@Contexts/Groups/Infrastructure/accounts.schema';

/** What the screens and the sign-in read of the accounts, from the SQLite file, outside any transaction. */
export class SqliteAccountQueries implements IAccountQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(ACCOUNT_STATEMENTS);
  }

  async findById(id: string): Promise<AccountReadModel | null> {
    const row = await this.database.exclusive(
      connection => connection.prepare('SELECT id, email, name FROM accounts WHERE id = ?').get(id) as unknown,
    );
    return (row as AccountReadModel | undefined) ?? null;
  }

  async findCredentials(email: string): Promise<AccountCredentials | null> {
    const row = (await this.database.exclusive(
      connection =>
        connection
          .prepare('SELECT id, password_hash FROM accounts WHERE email = ?')
          .get(email.trim().toLowerCase()) as unknown,
    )) as { id: string; password_hash: string } | undefined;
    return row ? { id: row.id, passwordHash: row.password_hash } : null;
  }
}
