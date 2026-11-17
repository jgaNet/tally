import { Inbox } from '@Architecture/Application/Inbox';
import { InMemoryDataSource } from '@Architecture/Infrastructure/DataSources/InMemoryDataSource';

/**
 * The inbox over an in-memory store (ADR 12). It is an InMemoryDataSource like the outbox, so the in-memory unit of work snapshots it
 * when a transaction begins and puts it back on a rollback: a mark a failed reaction made is gone with the reaction's other writes.
 * One per process, shared by every request's unit of work.
 */
export class InMemoryInbox implements Inbox {
  /** The process's inbox, for a unit of work built without one: specs, and the bootstrap's default. */
  static readonly shared = new InMemoryInbox();

  readonly store = new InMemoryDataSource<true>();

  private key(subscription: string, messageId: string): string {
    return `${subscription}\n${messageId}`;
  }

  async has(subscription: string, messageId: string): Promise<boolean> {
    return this.store.collection.has(this.key(subscription, messageId));
  }

  async record(subscription: string, messageId: string): Promise<void> {
    this.store.collection.set(this.key(subscription, messageId), true);
  }
}
