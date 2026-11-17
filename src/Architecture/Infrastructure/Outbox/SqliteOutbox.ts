import { v4 as uuidv4 } from 'uuid';

import { Event } from '@Architecture/Domain';
import { Outbox, OutboxEntry } from '@Architecture/Application';
import type { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

/**
 * The outbox in the application's SQLite file (ADR 24, docs/adr/0002): a table, `outbox`, written in
 * the transaction of the state it describes, so a rollback drops the facts with the state, and read
 * by the relay once the commit is through. Insertion order is publication order (`seq`). A published
 * entry is deleted, as the in-memory outbox drops it.
 *
 * What the relay hands to the bus is an `Event` with the name and the payload that were stored: the bus
 * routes on the name, and a handler reads the payload, so the class the event was made from is not
 * needed after the commit.
 */
export class SqliteOutbox implements Outbox {
  constructor(private readonly unit: SqliteUnitOfWork) {}

  async append(events: Event<unknown>[]): Promise<OutboxEntry[]> {
    return this.unit.run(() => {
      const insert = this.unit.database.connection.prepare('INSERT INTO outbox (id, name, payload) VALUES (?, ?, ?)');
      return events.map(event => {
        const entry = { id: uuidv4(), event };
        insert.run(entry.id, event.name, JSON.stringify(event.payload));
        return entry;
      });
    });
  }

  async pending(): Promise<OutboxEntry[]> {
    return this.unit.run(() =>
      this.unit.database.connection
        .prepare('SELECT id, name, payload FROM outbox ORDER BY seq')
        .all()
        .map(row => ({
          id: String(row.id),
          event: new Event<unknown>({ name: String(row.name), payload: JSON.parse(String(row.payload)) }),
        })),
    );
  }

  async markPublished(id: string): Promise<void> {
    await this.unit.run(() => {
      this.unit.database.connection.prepare('DELETE FROM outbox WHERE id = ?').run(id);
    });
  }
}
