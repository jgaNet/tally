import { Outbox, UnitOfWork } from '@Architecture/Application';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';

/**
 * The unit of work over the PostgreSQL database: one `BEGIN … COMMIT` per request, taken after the
 * process's turn on the connection and the write lock (ADR 22), so that what a repository writes and
 * what the outbox appends become durable together, or not at all (EVENT-AFTER-COMMIT).
 */
export class PostgresUnitOfWork implements UnitOfWork {
  #release: (() => void) | null = null;
  readonly outbox: Outbox;

  constructor(private readonly database: PostgresDatabase) {
    this.outbox = new PostgresOutbox(database);
  }

  async beginTransaction(): Promise<void> {
    if (this.#release) throw new Error('Transaction already in progress');
    const release = await this.database.acquire();
    try {
      await this.database.begin();
    } catch (error) {
      await this.database.connection.run('ROLLBACK').catch(() => undefined);
      release();
      throw error;
    }
    this.#release = release;
  }

  async commitTransaction(): Promise<void> {
    if (!this.#release) throw new Error('No active transaction to commit');
    try {
      await this.database.connection.run('COMMIT');
    } finally {
      this.#finish();
    }
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.#release) throw new Error('No active transaction to rollback');
    try {
      await this.database.connection.run('ROLLBACK');
    } finally {
      this.#finish();
    }
  }

  hasActiveTransaction(): boolean {
    return this.#release !== null;
  }

  another(): UnitOfWork {
    return new PostgresUnitOfWork(this.database);
  }

  #finish(): void {
    const release = this.#release;
    this.#release = null;
    release?.();
  }
}
