import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { Email } from '@SharedKernel/Domain';

import {
  AccountCredentials,
  AccountView,
  IAccountQueries,
} from '@Contexts/Groups/Domain/Account/Ports/IAccountQueries';
import { createAccountsTable } from '@Contexts/Groups/Infrastructure/Repositories/PostgresAccountRepository';

/**
 * The read side of accounts over the same database, answering from what is committed (ADR 4). A read made inside a
 * transaction sees that transaction's own writes.
 */
export class PostgresAccountQueries implements IAccountQueries {
  constructor(private database: PostgresDatabase) {
    createAccountsTable(database);
  }

  async findAccount(id: string): Promise<AccountView | null> {
    const row = await this.database.get<AccountView>('SELECT id, email, name FROM accounts WHERE id = ?', [id]);
    return row ? { id: row.id, email: row.email, name: row.name } : null;
  }

  async findCredentials(email: Email): Promise<AccountCredentials | null> {
    const row = await this.database.get<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM accounts WHERE email = ?',
      [email.value],
    );
    return row ? { id: row.id, passwordHash: row.password_hash } : null;
  }
}
