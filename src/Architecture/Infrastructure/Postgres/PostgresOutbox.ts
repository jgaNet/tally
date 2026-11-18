import { v4 as uuidv4 } from 'uuid';

import { Event } from '@Architecture/Domain';
import { Outbox, OutboxEntry } from '@Architecture/Application';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * The transactional outbox over the application's PostgreSQL database (ADR 20, ADR 24). `append()` is called inside the
 * transaction that made the facts, so an entry is written with the state it describes and a rollback drops it with them.
 * `pending()` and `markPublished()` are the relay's, outside any transaction. An entry keeps what the bus needs to route
 * it: its name and its payload.
 */
export class PostgresOutbox implements Outbox {
  constructor(private database: PostgresDatabase) {
    database.define(`
      CREATE TABLE IF NOT EXISTS outbox (
        seq BIGSERIAL PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  async append(events: Event<unknown>[]): Promise<OutboxEntry[]> {
    const entries: OutboxEntry[] = [];
    for (const event of events) {
      const entry = { id: uuidv4(), event };
      await this.database.run('INSERT INTO outbox (id, name, payload) VALUES (?, ?, ?)', [
        entry.id,
        event.name,
        JSON.stringify(event.payload ?? null),
      ]);
      entries.push(entry);
    }
    return entries;
  }

  async pending(): Promise<OutboxEntry[]> {
    const rows = await this.database.all<StoredEntry>('SELECT id, name, payload FROM outbox ORDER BY seq');
    return rows.map(row => ({
      id: row.id,
      event: new Event({ name: row.name, payload: JSON.parse(row.payload) }),
    }));
  }

  async markPublished(id: string): Promise<void> {
    await this.database.run('DELETE FROM outbox WHERE id = ?', [id]);
  }
}

interface StoredEntry {
  id: string;
  name: string;
  payload: string;
}
