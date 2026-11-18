import { ConcurrencyConflictException } from '@Architecture/Domain';
import { PostgresDatabase, isUniqueViolation } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { Email } from '@SharedKernel/Domain';

import { AccountCredentials, AccountView, IAccountStore } from '@Contexts/Groups/Application/IAccountStore';
import { Account } from '@Contexts/Groups/Domain/Account/Account';

/**
 * The accounts' table (ADR 2). The email is unique: the database refuses a second account with it, whatever its case. `version` is the one
 * the aggregate is stored at (CONC-OPTIMISTIC, as a group's is), and `suspended_at` is when an administrator suspended the account (feature 34):
 * present while it is suspended, and removed when it is reinstated. The two columns come after the table, so a database made before them gets them.
 */
export const accountsSchema = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id TEXT PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     password_hash TEXT NOT NULL
   )`,
  'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_at TEXT',
];

/**
 * The accounts in PostgreSQL. Its reads go to the committed data, and its one write to the transaction that holds the
 * writer (the command adds an account inside its transaction). The email is normalised the way the domain does, so
 * the lookup and the unique index agree.
 */
export class PostgresAccountStore implements IAccountStore {
  constructor(private readonly database: PostgresDatabase) {}

  async emailTaken(email: string): Promise<boolean> {
    return (await this.#rowOf(email)) !== undefined;
  }

  async add(account: Account): Promise<void> {
    const snapshot = account.toSnapshot();
    try {
      await this.database.writer
        .prepare('INSERT INTO accounts (id, email, name, password_hash, version) VALUES (?, ?, ?, ?, ?)')
        .run(snapshot.id, snapshot.email, snapshot.name, snapshot.passwordHash, snapshot.version + 1);
    } catch (error) {
      // Another server took the email between the lookup and this write: the command reads again and refuses (ADR 2).
      if (error instanceof Error && isUniqueViolation(error)) {
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
    const row = (await this.database.read(db =>
      db.prepare('SELECT id, email, name FROM accounts WHERE id = ?').get(id),
    )) as { id: string; email: string; name: string } | undefined;
    return row && { id: row.id, email: row.email, name: row.name };
  }

  async find(id: string): Promise<Account | undefined> {
    const row = (await this.database.read(db =>
      db.prepare('SELECT id, email, name, password_hash, version, suspended_at FROM accounts WHERE id = ?').get(id),
    )) as AccountRow | undefined;
    return row && Account.fromSnapshot(toSnapshot(row));
  }

  async save(account: Account): Promise<void> {
    const snapshot = account.toSnapshot();
    const { changes } = await this.database.writer
      .prepare('UPDATE accounts SET version = ?, suspended_at = ? WHERE id = ? AND version = ?')
      .run(snapshot.version + 1, snapshot.suspendedAt ?? null, snapshot.id, snapshot.version);
    if (changes === 0) {
      throw new ConcurrencyConflictException('Groups', 'The account changed since it was read: read it again');
    }
  }

  async #rowOf(email: string) {
    const normal = Email.create(email);
    if (normal.isFailure()) return undefined;
    return (await this.database.read(db =>
      db.prepare('SELECT id, password_hash FROM accounts WHERE email = ?').get(normal.data.value),
    )) as { id: string; password_hash: string } | undefined;
  }
}

/** An account's row as the store reads it: its columns, the suspension's time when there is one. */
interface AccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  version: number;
  suspended_at: string | null;
}

const toSnapshot = (row: AccountRow) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  passwordHash: row.password_hash,
  version: row.version,
  // Only a suspended account has the key (feature 34): the key is absent otherwise.
  ...(row.suspended_at === null ? {} : { suspendedAt: row.suspended_at }),
});
