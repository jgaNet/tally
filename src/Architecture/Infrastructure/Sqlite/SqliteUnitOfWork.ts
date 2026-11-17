import { Outbox, UnitOfWork } from '@Architecture/Application';
import { SqliteOutbox } from '@Architecture/Infrastructure/Outbox/SqliteOutbox';
import { SqliteDatabase, sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The transaction boundary over SQLite (docs/adr/0002): `beginTransaction()` takes the file's turn
 * and opens a `BEGIN IMMEDIATE` transaction, `commitTransaction()` commits and gives the turn back,
 * `rollbackTransaction()` undoes every write of the transaction and gives the turn back. A rollback
 * takes back only this unit's writes, and what it made durable in the outbox with them.
 *
 * One instance per request (the bootstrap builds one for each ExecutionContext): a unit of work is
 * the transaction it holds, and another request's unit of work waits for the file until this one
 * ends. `run()` is how the outbox reaches the file: inside this unit's transaction when it has one,
 * alone on the file when it has none, as after a commit, when the relay reads what is pending.
 */
export class SqliteUnitOfWork implements UnitOfWork {
  #release: (() => void) | null = null;
  readonly outbox: Outbox;

  constructor(readonly database: SqliteDatabase = sharedDatabase) {
    this.outbox = new SqliteOutbox(this);
  }

  async beginTransaction(): Promise<void> {
    if (this.#release) {
      throw new Error('Transaction already in progress');
    }
    const release = await this.database.acquire();
    try {
      this.database.connection.exec('BEGIN IMMEDIATE');
    } catch (error) {
      release();
      throw error;
    }
    this.database.setInTransaction(true);
    this.#release = release;
  }

  async commitTransaction(): Promise<void> {
    if (!this.#release) {
      throw new Error('No active transaction to commit');
    }
    // A failed COMMIT leaves the transaction open: the caller rolls it back, and that gives the turn back.
    this.database.connection.exec('COMMIT');
    this.#end();
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.#release) {
      throw new Error('No active transaction to rollback');
    }
    if (this.database.connection.isTransaction) this.database.connection.exec('ROLLBACK');
    this.#end();
  }

  hasActiveTransaction(): boolean {
    return this.#release !== null;
  }

  /** The same file, for a transaction of its own: a reaction's (ADR 30). */
  another(): UnitOfWork {
    return new SqliteUnitOfWork(this.database);
  }

  /** Runs `operation` on the file: inside this unit's transaction when it has one, alone on the file otherwise. */
  async run<T>(operation: () => T): Promise<T> {
    if (this.#release) return operation();
    return this.database.exclusive(operation);
  }

  #end(): void {
    const release = this.#release;
    this.#release = null;
    this.database.setInTransaction(false);
    release?.();
  }
}
