import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { IAccountRepository } from '@Contexts/Groups/Application/IAccountRepository';
import { AccountView, IAccountQueries } from '@Contexts/Groups/Application/IAccountQueries';

import { GroupsDatabase } from './GroupsDatabase';

type AccountRow = { id: string; email: string; name: string; password_hash: string };

/** The accounts in PostgreSQL: the repository the sign-up and sign-in use, and the read side `GetMyAccount` reads. */
export class SqliteAccounts implements IAccountRepository, IAccountQueries {
  constructor(private readonly database: GroupsDatabase) {}

  async findByEmail(email: Email): Promise<Account | undefined> {
    const row = await this.database.row<AccountRow>(
      'SELECT id, email, name, password_hash FROM accounts WHERE email = $1',
      [email.value],
    );
    return (
      row && Account.fromSnapshot({ id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash })
    );
  }

  async insert(account: Account): Promise<boolean> {
    const { id, email, name, passwordHash } = account.toSnapshot();
    // The unique index on the email refuses a second account with it, possibly written by another server: nothing is inserted then.
    const inserted = await this.database.execute(
      'INSERT INTO accounts (id, email, name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [id, email, name, passwordHash],
    );
    return inserted === 1;
  }

  async accountOf(id: string): Promise<AccountView | undefined> {
    const row = await this.database.row<Omit<AccountRow, 'password_hash'>>(
      'SELECT id, email, name FROM accounts WHERE id = $1',
      [id],
    );
    return row && { id: row.id, email: row.email, name: row.name };
  }
}
