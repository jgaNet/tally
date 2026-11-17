import { Outbox, UnitOfWork } from '@Architecture/Application';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';

/**
 * A transaction of the SQLite file: `BEGIN IMMEDIATE` takes the write lock at once (so two servers on the same file
 * queue instead of failing at their first write), and the process's own lock keeps every other request of this
 * process out until it commits or rolls back.
 */
export class SqliteUnitOfWork implements UnitOfWork {
  #release: (() => void) | null = null;

  constructor(
    private database: SqliteDatabase,
    readonly outbox: Outbox = new SqliteOutbox(database),
  ) {}

  async beginTransaction(): Promise<void> {
    if (this.#release) throw new Error('Transaction already in progress');
    const release = await this.database.lock();
    try {
      this.database.exec('BEGIN IMMEDIATE');
    } catch (error) {
      release();
      throw error;
    }
    this.#release = release;
  }

  async commitTransaction(): Promise<void> {
    this.end('COMMIT', 'No active transaction to commit');
  }

  async rollbackTransaction(): Promise<void> {
    this.end('ROLLBACK', 'No active transaction to rollback');
  }

  hasActiveTransaction(): boolean {
    return this.#release !== null;
  }

  another(): UnitOfWork {
    return new SqliteUnitOfWork(this.database, this.outbox);
  }

  private end(statement: 'COMMIT' | 'ROLLBACK', missing: string): void {
    const release = this.#release;
    if (!release) throw new Error(missing);
    try {
      this.database.exec(statement);
    } catch (error) {
      // A commit that failed leaves the transaction open: it is rolled back, and the failure is the caller's.
      if (statement === 'COMMIT') this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.#release = null;
      release();
    }
  }
}
