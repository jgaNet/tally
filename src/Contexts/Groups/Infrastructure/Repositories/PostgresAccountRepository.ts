import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { IAccountSnapshot } from '@Contexts/Groups/Domain/Account/DTOs';
import { IAccountRepository } from '@Contexts/Groups/Domain/Account/Ports/IAccountRepository';
import { eraseFactsOf } from '@Contexts/Groups/Infrastructure/Repositories/ErasedFacts';

/**
 * The table of accounts: one row per account, its email unique across all of them while it is held (a deleted account keeps no
 * email, request 35), its suspension when it is suspended (request 34), its deletion when it is deleted (request 35).
 */
export function createAccountsTable(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      suspended_at TEXT,
      deleted_at TEXT,
      version INTEGER NOT NULL
    );
  `);
}

interface AccountRow {
  id: string;
  email: string | null;
  name: string;
  password_hash: string;
  suspended_at: string | null;
  deleted_at: string | null;
  version: number;
}

/**
 * The accounts as aggregates, over the application's PostgreSQL database. Used inside the transaction of the command
 * that asks for it, whose scope carries its statements, so they are part of that transaction.
 */
export class PostgresAccountRepository implements IAccountRepository {
  constructor(private database: PostgresDatabase) {
    createAccountsTable(database);
  }

  async findById(id: string): Promise<Account | null> {
    const row = await this.database.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id]);
    return row ? Account.fromSnapshot(toSnapshot(row)) : null;
  }

  async findByEmail(email: Email): Promise<Account | null> {
    const row = await this.database.get<AccountRow>('SELECT * FROM accounts WHERE email = ?', [email.value]);
    return row ? Account.fromSnapshot(toSnapshot(row)) : null;
  }

  /**
   * The optimistic check as SQL makes it atomic: the update applies only to the row still at the version the
   * account was read at; no row changed means another writer got there first (ADR 8). A new account is inserted
   * at version 1. When the account is deleted, the name and the email it was saved with are erased from the facts
   * Groups keeps about it, in this same transaction (request 35).
   */
  async save(account: Account): Promise<IResult> {
    const snapshot = account.toSnapshot();
    const { _id: id, email, name, passwordHash, deletedAt, suspendedAt, version } = snapshot;

    const stored =
      deletedAt !== null ? await this.database.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id]) : undefined;

    const updated = await this.database.run(
      'UPDATE accounts SET email = ?, name = ?, password_hash = ?, suspended_at = ?, deleted_at = ?, version = ? WHERE id = ? AND version = ?',
      [email, name, passwordHash, suspendedAt, deletedAt, version + 1, id, version],
    );
    if (updated.changes > 0) {
      if (stored) await eraseFactsOf(this.database, id, [stored.email, stored.name].filter(isText));
      return Result.ok();
    }

    const current = await this.database.get('SELECT version FROM accounts WHERE id = ?', [id]);
    if (current) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The account changed since it was read', { id }));
    }

    await this.database.run(
      'INSERT INTO accounts (id, email, name, password_hash, suspended_at, deleted_at, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, email, name, passwordHash, suspendedAt, deletedAt, version + 1],
    );
    return Result.ok();
  }
}

function isText(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function toSnapshot(row: AccountRow): IAccountSnapshot {
  return {
    _id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    deletedAt: row.deleted_at,
    suspendedAt: row.suspended_at,
    version: row.version,
  };
}
