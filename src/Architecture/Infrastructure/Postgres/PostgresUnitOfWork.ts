import type { PoolClient } from 'pg';

import { Outbox, UnitOfWork } from '@Architecture/Application';
import {
  PostgresDatabase,
  TransactionScope,
  WRITES_LOCK,
} from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * The transaction boundary over the application's PostgreSQL database (ADR 20): `beginTransaction()` takes the process's
 * turn for writes, a connection of its own, and the advisory lock every write takes, then opens the transaction;
 * `commitTransaction()` commits and gives the three back; `rollbackTransaction()` undoes everything written since the
 * begin and gives them back. The transaction's queries run on its connection (the scope `within()` sets), so they see
 * its writes and no one else's, and a rollback leaves nothing of it behind, its outbox entries included.
 *
 * The outbox is the unit of work's, written in the same database, so a fact is durable with the state it describes (ADR 24).
 * One unit of work per request, as the in-memory one: they share the database, not a transaction.
 */
export class PostgresUnitOfWork implements UnitOfWork {
  readonly #scope: TransactionScope = {};
  #release: (() => void) | null = null;

  constructor(
    private database: PostgresDatabase,
    readonly outbox: Outbox,
  ) {}

  async beginTransaction(): Promise<void> {
    if (this.#release) {
      throw new Error('Transaction already in progress');
    }
    const release = await this.database.acquireTurn();
    let client: PoolClient | undefined;
    try {
      client = await this.database.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITES_LOCK]);
    } catch (error) {
      client?.release(true);
      release();
      throw error;
    }
    this.#scope.client = client;
    this.#release = release;
  }

  async commitTransaction(): Promise<void> {
    const { client, release } = this.#take('commit');
    try {
      await client.query('COMMIT');
    } catch (error) {
      // A commit that fails leaves nothing behind: undo it, and give the connection back broken.
      await client.query('ROLLBACK').catch(() => undefined);
      client.release(true);
      release();
      throw error;
    }
    client.release();
    release();
  }

  async rollbackTransaction(): Promise<void> {
    const { client, release } = this.#take('rollback');
    try {
      await client.query('ROLLBACK');
      client.release();
    } catch (error) {
      client.release(true);
      throw error;
    } finally {
      release();
    }
  }

  hasActiveTransaction(): boolean {
    return this.#release !== null;
  }

  /** The same database and outbox, for a transaction of its own: a reaction's (ADR 30). */
  another(): UnitOfWork {
    return new PostgresUnitOfWork(this.database, this.outbox);
  }

  /** The transaction's own reads and writes run on its connection while `run` runs (ADR 4). */
  within<T>(run: () => Promise<T>): Promise<T> {
    return this.database.inScope(this.#scope, run);
  }

  #take(action: 'commit' | 'rollback'): { client: PoolClient; release: () => void } {
    const release = this.#release;
    const client = this.#scope.client;
    if (!release || !client) {
      throw new Error(`No active transaction to ${action}`);
    }
    this.#release = null;
    this.#scope.client = undefined;
    return { client, release };
  }
}
