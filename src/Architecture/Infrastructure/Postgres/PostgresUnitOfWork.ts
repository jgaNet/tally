import { Outbox, UnitOfWork } from '@Architecture/Application';
import { PostgresOutbox } from '@Architecture/Infrastructure/Outbox/PostgresOutbox';
import {
  PostgresDatabase,
  sharedDatabase,
  TransactionScope,
} from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * The transaction boundary over PostgreSQL (docs/adr/0029): `beginTransaction()` takes the process's turn and opens a
 * transaction under the advisory lock, bound to the caller's flow; `commitTransaction()` commits and gives the turn
 * back; `rollbackTransaction()` undoes every write of the transaction and gives the turn back. A rollback takes back
 * only this unit's writes, and what it made durable in the outbox with them.
 *
 * One instance per request (the bootstrap builds one for each ExecutionContext): a unit of work is the transaction it
 * holds, and another request's unit of work waits for the turn until this one ends. `run()` is how the outbox reaches
 * the database: inside this unit's transaction when it has one, alone in the process when it has none, as after a
 * commit, when the relay reads what is pending.
 */
export class PostgresUnitOfWork implements UnitOfWork {
  #release: (() => void) | null = null;
  #scope?: TransactionScope;
  readonly outbox: Outbox;

  constructor(readonly database: PostgresDatabase = sharedDatabase) {
    this.outbox = new PostgresOutbox(this);
  }

  async beginTransaction(): Promise<void> {
    if (this.#release) {
      throw new Error('Transaction already in progress');
    }
    // The scope is bound to the caller's flow before the first await, so the use case that runs next inherits it.
    const scope = this.database.beginScope();
    const release = await this.database.acquire();
    try {
      await this.database.openTransaction(scope);
    } catch (error) {
      release();
      throw error;
    }
    this.#scope = scope;
    this.#release = release;
  }

  async commitTransaction(): Promise<void> {
    if (!this.#release || !this.#scope) {
      throw new Error('No active transaction to commit');
    }
    // A failed COMMIT leaves the transaction open: the caller rolls it back, and that gives the turn back.
    await this.database.commitOpenTransaction(this.#scope);
    this.#end();
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.#release || !this.#scope) {
      throw new Error('No active transaction to rollback');
    }
    await this.database.rollbackOpenTransaction(this.#scope);
    this.#end();
  }

  hasActiveTransaction(): boolean {
    return this.#release !== null;
  }

  /** The same database, for a transaction of its own: a reaction's (ADR 30). */
  another(): UnitOfWork {
    return new PostgresUnitOfWork(this.database);
  }

  /** Runs `operation` on the database: inside this unit's transaction when it has one, alone in the process otherwise. */
  async run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#release) return operation();
    return this.database.exclusive(operation);
  }

  #end(): void {
    const release = this.#release;
    this.#release = null;
    this.#scope = undefined;
    release?.();
  }
}
