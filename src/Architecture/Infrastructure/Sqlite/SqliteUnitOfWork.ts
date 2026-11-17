import { Outbox, UnitOfWork } from '@Architecture/Application';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';

/**
 * The unit of work over the SQLite file: one `BEGIN IMMEDIATE … COMMIT` per request, taken after
 * the process's turn on the connection, so that what a repository writes and what the outbox
 * appends become durable together, or not at all (EVENT-AFTER-COMMIT).
 */
export class SqliteUnitOfWork implements UnitOfWork {
  #release: (() => void) | null = null;
  readonly outbox: Outbox;

  constructor(private readonly database: SqliteDatabase) {
    this.outbox = new SqliteOutbox(database);
  }

  async beginTransaction(): Promise<void> {
    if (this.#release) throw new Error('Transaction already in progress');
    const release = await this.database.acquire();
    try {
      this.database.connection.exec('BEGIN IMMEDIATE');
    } catch (error) {
      release();
      throw error;
    }
    this.#release = release;
  }

  async commitTransaction(): Promise<void> {
    if (!this.#release) throw new Error('No active transaction to commit');
    this.database.connection.exec('COMMIT');
    this.#finish();
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.#release) throw new Error('No active transaction to rollback');
    try {
      if (this.database.connection.isTransaction) this.database.connection.exec('ROLLBACK');
    } finally {
      this.#finish();
    }
  }

  hasActiveTransaction(): boolean {
    return this.#release !== null;
  }

  another(): UnitOfWork {
    return new SqliteUnitOfWork(this.database);
  }

  #finish(): void {
    const release = this.#release;
    this.#release = null;
    release?.();
  }
}
