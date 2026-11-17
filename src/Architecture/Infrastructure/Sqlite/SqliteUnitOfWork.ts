import { Outbox, UnitOfWork } from '@Architecture/Application';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The transaction boundary over the application's SQLite file (ADR 2): `beginTransaction()` takes the
 * process's turn at the file and opens an immediate transaction, `commitTransaction()` commits and gives
 * the turn back, `rollbackTransaction()` undoes everything written since the begin and gives it back.
 * Unlike the in-memory unit of work, this one isolates: what a transaction wrote is visible to no one
 * until it commits, and a rollback leaves nothing of it behind, its outbox entries included.
 *
 * The outbox is the unit of work's, written in the same file, so a fact is durable with the state it
 * describes (ADR 24). One unit of work per request, as the in-memory one: they share the file, not a
 * transaction.
 */
export class SqliteUnitOfWork implements UnitOfWork {
  #release: (() => void) | null = null;

  constructor(
    private database: SqliteDatabase,
    readonly outbox: Outbox,
  ) {}

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
    this.#release = release;
  }

  async commitTransaction(): Promise<void> {
    const release = this.#take('commit');
    try {
      this.database.connection.exec('COMMIT');
    } catch (error) {
      // A commit that fails leaves the transaction open: undo it, so the file is not left in one.
      this.database.connection.exec('ROLLBACK');
      throw error;
    } finally {
      release();
    }
  }

  async rollbackTransaction(): Promise<void> {
    const release = this.#take('rollback');
    try {
      this.database.connection.exec('ROLLBACK');
    } finally {
      release();
    }
  }

  hasActiveTransaction(): boolean {
    return this.#release !== null;
  }

  /** The same file and outbox, for a transaction of its own: a reaction's (ADR 30). */
  another(): UnitOfWork {
    return new SqliteUnitOfWork(this.database, this.outbox);
  }

  /** The transaction's own reads of the file run in its scope, without waiting for the turn it holds (ADR 4). */
  within<T>(run: () => Promise<T>): Promise<T> {
    return this.database.within(run);
  }

  #take(action: 'commit' | 'rollback'): () => void {
    const release = this.#release;
    if (!release) {
      throw new Error(`No active transaction to ${action}`);
    }
    this.#release = null;
    return release;
  }
}
