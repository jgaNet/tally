import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Email } from '@SharedKernel/Domain';

import { AccountCredentials, AccountView, IAccountStore } from '@Contexts/Groups/Application/IAccountStore';
import { Account } from '@Contexts/Groups/Domain/Account/Account';

/** The accounts' table (ADR 2). The email is unique: the database refuses a second account with it, whatever its case. */
export const accountsSchema = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     password_hash TEXT NOT NULL
   )`,
];

/**
 * The accounts in SQLite. Its reads go to the committed data, and its one write to the transaction that holds the
 * writer (the command adds an account inside its transaction). The email is normalised the way the domain does, so
 * the lookup and the unique index agree.
 */
export class SqliteAccountStore implements IAccountStore {
  constructor(private readonly database: SqliteDatabase) {}

  async emailTaken(email: string): Promise<boolean> {
    return (await this.#rowOf(email)) !== undefined;
  }

  async add(account: Account): Promise<void> {
    const snapshot = account.toSnapshot();
    try {
      this.database.writer
        .prepare('INSERT INTO accounts (id, email, name, password_hash) VALUES (?, ?, ?, ?)')
        .run(snapshot.id, snapshot.email, snapshot.name, snapshot.passwordHash);
    } catch (error) {
      // Another server took the email between the lookup and this write: the command reads again and refuses (ADR 2).
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConcurrencyConflictException('Groups', 'An account with this email was added at the same time');
      }
      throw error;
    }
  }

  async credentialsOf(email: string): Promise<AccountCredentials | undefined> {
    const row = await this.#rowOf(email);
    return row && { id: row.id, passwordHash: row.password_hash };
  }

  async view(id: string): Promise<AccountView | undefined> {
    const row = this.database.read(db => db.prepare('SELECT id, email, name FROM accounts WHERE id = ?').get(id)) as
      { id: string; email: string; name: string } | undefined;
    return row && { id: row.id, email: row.email, name: row.name };
  }

  async #rowOf(email: string) {
    const normal = Email.create(email);
    if (normal.isFailure()) return undefined;
    return this.database.read(db =>
      db.prepare('SELECT id, password_hash FROM accounts WHERE email = ?').get(normal.data.value),
    ) as { id: string; password_hash: string } | undefined;
  }
}
