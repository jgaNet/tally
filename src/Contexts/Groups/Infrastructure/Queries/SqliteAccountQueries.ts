import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Email } from '@SharedKernel/Domain';

import {
  AccountCredentials,
  AccountView,
  IAccountQueries,
} from '@Contexts/Groups/Domain/Account/Ports/IAccountQueries';
import { createAccountsTable } from '@Contexts/Groups/Infrastructure/Repositories/SqliteAccountRepository';

/**
 * The read side of accounts over the same file, answering from what is kept now. Reads take the file's turn, so
 * they never see a transaction still in progress.
 */
export class SqliteAccountQueries implements IAccountQueries {
  constructor(private database: SqliteDatabase) {
    createAccountsTable(database);
  }

  findAccount(id: string): Promise<AccountView | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT id, email, name FROM accounts WHERE id = ?').get(id) as
        AccountView | undefined;
      return row ? { id: row.id, email: row.email, name: row.name } : null;
    });
  }

  findCredentials(email: Email): Promise<AccountCredentials | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT id, password_hash FROM accounts WHERE email = ?').get(email.value) as
        { id: string; password_hash: string } | undefined;
      return row ? { id: row.id, passwordHash: row.password_hash } : null;
    });
  }
}
