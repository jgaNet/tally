import { Outbox, UnitOfWork } from '@Architecture/Application';
import { PostgresDatabase, TransactionScope } from '@Architecture/Infrastructure/DataSources/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Outbox/PostgresOutbox';

/**
 * The transaction boundary over PostgreSQL. `beginTransaction()` enters a transaction for the chain that calls it, so that every
 * query the chain makes after it, the repositories' and the outbox's, runs in it; `commitTransaction()` and
 * `rollbackTransaction()` end it. The outbox is a table in the same database, so what a transaction appends commits or rolls back
 * with the state it describes (ADR 24). One per request (see the bootstrap), and one per reaction (`another()`).
 */
export class PostgresUnitOfWork implements UnitOfWork {
  #scope?: TransactionScope;

  constructor(
    private readonly database: PostgresDatabase,
    readonly outbox: Outbox = new PostgresOutbox(database),
  ) {}

  async beginTransaction(): Promise<void> {
    if (this.#scope) {
      throw new Error('Transaction already in progress');
    }
    // The scope is entered synchronously, before the first await, so the chain that began the transaction sees it at once.
    const scope: TransactionScope = {};
    this.#scope = scope;
    PostgresDatabase.enterScope(scope);
    try {
      await this.database.openScope(scope);
    } catch (error) {
      this.#scope = undefined;
      throw error;
    }
  }

  async commitTransaction(): Promise<void> {
    const scope = this.#scope;
    if (!scope) {
      throw new Error('No active transaction to commit');
    }
    this.#scope = undefined;
    await this.database.closeScope(scope, 'commit');
  }

  async rollbackTransaction(): Promise<void> {
    const scope = this.#scope;
    if (!scope) {
      throw new Error('No active transaction to rollback');
    }
    this.#scope = undefined;
    await this.database.closeScope(scope, 'rollback');
  }

  hasActiveTransaction(): boolean {
    return this.#scope !== undefined;
  }

  /** The same database and outbox, for a transaction of its own: a reaction's (ADR 30). */
  another(): UnitOfWork {
    return new PostgresUnitOfWork(this.database, this.outbox);
  }
}
