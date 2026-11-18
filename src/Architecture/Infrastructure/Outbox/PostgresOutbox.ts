import { v4 as uuidv4 } from 'uuid';

import { Event } from '@Architecture/Domain';
import { Outbox, OutboxEntry } from '@Architecture/Application';
import type { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';

/**
 * The outbox in the application's database (ADR 24, docs/adr/0029): a table, `outbox`, written in the transaction of
 * the state it describes, so a rollback drops the facts with the state, and read by the relay once the commit is
 * through. Insertion order is publication order (`seq`). A published entry is deleted, as the in-memory outbox drops it.
 *
 * What the relay hands to the bus is an `Event` with the name and the payload that were stored: the bus routes on the
 * name, and a handler reads the payload, so the class the event was made from is not needed after the commit.
 */
export class PostgresOutbox implements Outbox {
  constructor(private readonly unit: PostgresUnitOfWork) {}

  async append(events: Event<unknown>[]): Promise<OutboxEntry[]> {
    return this.unit.run(async () => {
      const entries: OutboxEntry[] = [];
      for (const event of events) {
        const entry = { id: uuidv4(), event };
        await this.unit.database.run('INSERT INTO outbox (id, name, payload) VALUES (?, ?, ?)', [
          entry.id,
          event.name,
          JSON.stringify(event.payload),
        ]);
        entries.push(entry);
      }
      return entries;
    });
  }

  async pending(): Promise<OutboxEntry[]> {
    return this.unit.run(async () =>
      (await this.unit.database.all('SELECT id, name, payload FROM outbox ORDER BY seq')).map(row => ({
        id: String(row.id),
        event: new Event<unknown>({ name: String(row.name), payload: JSON.parse(String(row.payload)) }),
      })),
    );
  }

  async markPublished(id: string): Promise<void> {
    await this.unit.run(async () => {
      await this.unit.database.run('DELETE FROM outbox WHERE id = ?', [id]);
    });
  }
}
