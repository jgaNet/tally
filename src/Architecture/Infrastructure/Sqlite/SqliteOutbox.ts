import { v4 as uuidv4 } from 'uuid';

import { Event } from '@Architecture/Domain';
import { Outbox, OutboxEntry } from '@Architecture/Application';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The transactional outbox over the application's SQLite file (ADR 24). `append()` is called inside the
 * transaction that made the facts, so an entry is written with the state it describes and a rollback
 * drops it with them. `pending()` and `markPublished()` are the relay's, outside any transaction, and
 * wait for the file's turn like any read. An entry keeps what the bus needs to route it: its name and
 * its payload. A fact read back from the file is published under the same name and payload, which is
 * all a subscriber is given (the bus routes by name).
 */
export class SqliteOutbox implements Outbox {
  constructor(private database: SqliteDatabase) {
    database.connection.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
  }

  async append(events: Event<unknown>[]): Promise<OutboxEntry[]> {
    return events.map(event => {
      const entry = { id: uuidv4(), event };
      this.database.connection
        .prepare('INSERT INTO outbox (id, name, payload) VALUES (?, ?, ?)')
        .run(entry.id, event.name, JSON.stringify(event.payload ?? null));
      return entry;
    });
  }

  async pending(): Promise<OutboxEntry[]> {
    return this.database.exclusive(connection =>
      (connection.prepare('SELECT id, name, payload FROM outbox ORDER BY seq').all() as unknown as StoredEntry[]).map(
        row => ({
          id: row.id,
          event: new Event({ name: row.name, payload: JSON.parse(row.payload) }),
        }),
      ),
    );
  }

  async markPublished(id: string): Promise<void> {
    await this.database.exclusive(connection => connection.prepare('DELETE FROM outbox WHERE id = ?').run(id));
  }
}

interface StoredEntry {
  id: string;
  name: string;
  payload: string;
}
