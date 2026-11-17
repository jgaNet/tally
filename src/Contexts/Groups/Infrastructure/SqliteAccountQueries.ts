import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ACCOUNTS_SCHEMA } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { AccountView, IAccountQueries } from '@Contexts/Groups/Domain/Account/Ports/IAccountQueries';

/** The read side of the accounts over SQLite: one read of the file, taken alone, outside any transaction. */
export class SqliteAccountQueries implements IAccountQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(ACCOUNTS_SCHEMA));
  }

  async findAccount(id: string): Promise<AccountView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection.prepare('SELECT id, email, name FROM accounts WHERE id = ?').get(id) as
        { id: string; email: string; name: string } | undefined;
      return row ? { id: String(row.id), email: String(row.email), name: String(row.name) } : undefined;
    });
  }
}
