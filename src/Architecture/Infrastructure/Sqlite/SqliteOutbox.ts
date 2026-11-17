import { v4 as uuidv4 } from 'uuid';

import { Event } from '@Architecture/Domain';
import { Outbox, OutboxEntry } from '@Architecture/Application/Outbox';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The outbox in the database (ADR 2, ADR 24): a row per fact, written in the transaction that made it, so a
 * rollback drops it with the writes it describes, and a commit keeps it until a relay has delivered it. A
 * fact is stored by its name and payload; the relay hands the bus an `Event` of that name, which is all the
 * bus routes on. Insertion order is publication order (`seq`).
 */
export class SqliteOutbox implements Outbox {
  constructor(private readonly database: SqliteDatabase) {}

  /** Inside the transaction that holds the writer: the entries are rolled back with its other writes. */
  async append(events: Event<unknown>[]): Promise<OutboxEntry[]> {
    const insert = this.database.writer.prepare('INSERT INTO outbox (id, name, payload) VALUES (?, ?, ?)');
    return events.map(event => {
      const entry = { id: uuidv4(), event };
      insert.run(entry.id, event.name, JSON.stringify(event.payload));
      return entry;
    });
  }

  /** What is committed and not yet published, oldest first. */
  async pending(): Promise<OutboxEntry[]> {
    const rows = this.database.read(db => db.prepare('SELECT id, name, payload FROM outbox ORDER BY seq').all()) as {
      id: string;
      name: string;
      payload: string;
    }[];
    return rows.map(row => ({
      id: row.id,
      event: new Event({ name: row.name, payload: JSON.parse(row.payload) }),
    }));
  }

  /** Acknowledges a delivery: the entry is not handed out again. Its own write, on the turn. */
  async markPublished(id: string): Promise<void> {
    await this.database.writeAlone(db => db.prepare('DELETE FROM outbox WHERE id = ?').run(id));
  }
}
