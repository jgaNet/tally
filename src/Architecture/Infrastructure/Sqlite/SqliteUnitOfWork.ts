import { UnitOfWork } from '@Architecture/Application/ExecutionContext';
import { Inbox } from '@Architecture/Application/Inbox';
import { Outbox } from '@Architecture/Application/Outbox';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteInbox } from '@Architecture/Infrastructure/Sqlite/SqliteInbox';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';

/**
 * The transaction boundary over SQLite (ADR 2): the four methods of UnitOfWork, given by the database.
 * `beginTransaction()` takes the database's turn and opens `BEGIN IMMEDIATE`; `commitTransaction()` makes
 * the writes and the outbox entries durable together; `rollbackTransaction()` keeps neither. A request
 * holds one of these; the connections are shared, the transactions are not.
 *
 * The outbox is the database's too (`SqliteOutbox`): an entry is written with the state it describes, in
 * the same transaction, and is relayed after the commit by whichever server runs the relay (ADR 24).
 */
export class SqliteUnitOfWork implements UnitOfWork {
  readonly outbox: Outbox;
  readonly inbox: Inbox;
  #open = false;

  constructor(private readonly database: SqliteDatabase) {
    this.outbox = new SqliteOutbox(database);
    this.inbox = new SqliteInbox(database);
  }

  async beginTransaction(): Promise<void> {
    if (this.#open) throw new Error('Transaction already in progress');
    await this.database.begin();
    this.#open = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.#open) throw new Error('No active transaction to commit');
    this.#open = false;
    this.database.commit();
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.#open) throw new Error('No active transaction to rollback');
    this.#open = false;
    this.database.rollback();
  }

  hasActiveTransaction(): boolean {
    return this.#open;
  }

  /** The same database, for a transaction of its own: a reaction's (ADR 30). */
  another(): UnitOfWork {
    return new SqliteUnitOfWork(this.database);
  }
}
