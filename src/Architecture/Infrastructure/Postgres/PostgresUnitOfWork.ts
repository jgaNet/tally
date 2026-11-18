import { Outbox, UnitOfWork } from '@Architecture/Application';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';

/**
 * A transaction of the PostgreSQL database: it takes the database's write lock as it begins (so two servers on the same
 * database queue instead of meeting at their first write), and the process's own lock keeps every other request of this
 * process out until it commits or rolls back.
 */
export class PostgresUnitOfWork implements UnitOfWork {
  #release: (() => void) | null = null;

  constructor(
    private database: PostgresDatabase,
    readonly outbox: Outbox = new PostgresOutbox(database),
  ) {}

  async beginTransaction(): Promise<void> {
    if (this.#release) throw new Error('Transaction already in progress');
    const release = await this.database.lock();
    try {
      await this.database.query('BEGIN');
      await this.database.lockWrites();
    } catch (error) {
      await this.database.query('ROLLBACK').catch(() => undefined);
      release();
      throw error;
    }
    this.#release = release;
  }

  async commitTransaction(): Promise<void> {
    await this.end('COMMIT', 'No active transaction to commit');
  }

  async rollbackTransaction(): Promise<void> {
    await this.end('ROLLBACK', 'No active transaction to rollback');
  }

  hasActiveTransaction(): boolean {
    return this.#release !== null;
  }

  another(): UnitOfWork {
    return new PostgresUnitOfWork(this.database, this.outbox);
  }

  private async end(statement: 'COMMIT' | 'ROLLBACK', missing: string): Promise<void> {
    const release = this.#release;
    if (!release) throw new Error(missing);
    try {
      await this.database.query(statement);
    } catch (error) {
      // A commit that failed leaves the transaction open: it is rolled back, and the failure is the caller's.
      if (statement === 'COMMIT') await this.database.query('ROLLBACK');
      throw error;
    } finally {
      this.#release = null;
      release();
    }
  }
}
