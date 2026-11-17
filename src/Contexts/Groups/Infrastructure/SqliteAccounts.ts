import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { IAccountRepository } from '@Contexts/Groups/Application/IAccountRepository';
import { AccountView, IAccountQueries } from '@Contexts/Groups/Application/IAccountQueries';

import { GroupsDatabase } from './GroupsDatabase';

type AccountRow = { id: string; email: string; name: string; password_hash: string };

/** The accounts in SQLite: the repository the sign-up and sign-in use, and the read side `GetMyAccount` reads. */
export class SqliteAccounts implements IAccountRepository, IAccountQueries {
  constructor(private readonly database: GroupsDatabase) {}

  async findByEmail(email: Email): Promise<Account | undefined> {
    const row = this.database.connection
      .prepare('SELECT id, email, name, password_hash FROM accounts WHERE email = ?')
      .get(email.value) as AccountRow | undefined;
    return (
      row && Account.fromSnapshot({ id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash })
    );
  }

  async insert(account: Account): Promise<boolean> {
    const { id, email, name, passwordHash } = account.toSnapshot();
    try {
      this.database.connection
        .prepare('INSERT INTO accounts (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
        .run(id, email, name, passwordHash);
      return true;
    } catch (error) {
      // The unique index on the email refused it: another account took the email, possibly on another server.
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return false;
      throw error;
    }
  }

  async accountOf(id: string): Promise<AccountView | undefined> {
    const row = this.database.connection.prepare('SELECT id, email, name FROM accounts WHERE id = ?').get(id) as
      Omit<AccountRow, 'password_hash'> | undefined;
    return row && { id: row.id, email: row.email, name: row.name };
  }
}
