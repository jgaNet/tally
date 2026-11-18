import { UnitOfWork } from '@Architecture/Application/ExecutionContext';
import { Inbox } from '@Architecture/Application/Inbox';
import { Outbox } from '@Architecture/Application/Outbox';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresInbox } from '@Architecture/Infrastructure/Postgres/PostgresInbox';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';

/**
 * The transaction boundary over PostgreSQL (ADR 2, ADR 25): the four methods of UnitOfWork, given by the database.
 * `beginTransaction()` takes the database's turn and opens the write lock; `commitTransaction()` makes
 * the writes and the outbox entries durable together; `rollbackTransaction()` keeps neither. A request
 * holds one of these; the connections are shared, the transactions are not.
 *
 * The outbox is the database's too (`PostgresOutbox`): an entry is written with the state it describes, in
 * the same transaction, and is relayed after the commit by whichever server runs the relay (ADR 24).
 */
export class PostgresUnitOfWork implements UnitOfWork {
  readonly outbox: Outbox;
  readonly inbox: Inbox;
  #open = false;

  constructor(private readonly database: PostgresDatabase) {
    this.outbox = new PostgresOutbox(database);
    this.inbox = new PostgresInbox(database);
  }

  async beginTransaction(): Promise<void> {
    if (this.#open) throw new Error('Transaction already in progress');
    await this.database.begin();
    this.#open = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.#open) throw new Error('No active transaction to commit');
    this.#open = false;
    await this.database.commit();
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.#open) throw new Error('No active transaction to rollback');
    this.#open = false;
    await this.database.rollback();
  }

  hasActiveTransaction(): boolean {
    return this.#open;
  }

  /** The same database, for a transaction of its own: a reaction's (ADR 30). */
  another(): UnitOfWork {
    return new PostgresUnitOfWork(this.database);
  }
}
