import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { IAccountRepository } from '@Contexts/Groups/Application/IAccountRepository';
import { AccountView, IAccountQueries } from '@Contexts/Groups/Application/IAccountQueries';

import { GroupsDatabase } from './GroupsDatabase';

type AccountRow = {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  version: number;
  suspended_at: string | null;
};

/** The accounts in PostgreSQL: the repository the sign-up, the sign-in and the administrators' suspensions use, and the read side `GetMyAccount` reads. */
export class SqliteAccounts implements IAccountRepository, IAccountQueries {
  constructor(private readonly database: GroupsDatabase) {}

  async findByEmail(email: Email): Promise<Account | undefined> {
    const row = await this.database.row<AccountRow>(
      'SELECT id, email, name, password_hash, version, suspended_at FROM accounts WHERE email = $1',
      [email.value],
    );
    return row && toAccount(row);
  }

  async findById(id: string): Promise<Account | undefined> {
    const row = await this.database.row<AccountRow>(
      'SELECT id, email, name, password_hash, version, suspended_at FROM accounts WHERE id = $1',
      [id],
    );
    return row && toAccount(row);
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

  async save(account: Account): Promise<void> {
    const { id, suspendedAt } = account.toSnapshot();
    // The account is stored at the version it was read at: a save over a newer one is refused, and the use case re-reads (CONC-OPTIMISTIC).
    const updated = await this.database.execute(
      'UPDATE accounts SET version = $1, suspended_at = $2 WHERE id = $3 AND version = $4',
      [account.version + 1, suspendedAt ?? null, id, account.version],
    );
    if (updated !== 1) throw new ConcurrencyConflictException('Groups', 'The account changed since it was read');
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async accountOf(id: string): Promise<AccountView | undefined> {
    const row = await this.database.row<Pick<AccountRow, 'id' | 'email' | 'name'>>(
      'SELECT id, email, name FROM accounts WHERE id = $1',
      [id],
    );
    return row && { id: row.id, email: row.email, name: row.name };
  }
}

/** The account a row of the accounts table is, at the version it was stored at, suspended when the row says so. */
function toAccount(row: AccountRow): Account {
  return Account.fromSnapshot({
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    version: row.version,
    ...(row.suspended_at ? { suspendedAt: row.suspended_at } : {}),
  });
}
