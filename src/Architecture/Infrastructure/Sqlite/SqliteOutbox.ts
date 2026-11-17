import { v4 as uuidv4 } from 'uuid';
import { DomainEvent, Event, IntegrationEvent } from '@Architecture/Domain';
import { Outbox, OutboxEntry } from '@Architecture/Application';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The outbox in the SQLite file (ADR 24, ADR 2). `append()` is called by the unit of work's
 * commit step, inside the transaction, so an entry exists exactly when the state it describes
 * does; `pending()` and `markPublished()` are the relay's, after the commit, and survive a crash:
 * what was not published is published at the next start.
 */
export class SqliteOutbox implements Outbox {
  static readonly STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS outbox (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       id TEXT NOT NULL UNIQUE,
       kind TEXT NOT NULL,
       name TEXT NOT NULL,
       payload TEXT NOT NULL
     )`,
  ];

  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SqliteOutbox.STATEMENTS);
  }

  /** Inside the transaction that holds the connection. */
  async append(events: Event<unknown>[]): Promise<OutboxEntry[]> {
    const insert = this.database.connection.prepare('INSERT INTO outbox (id, kind, name, payload) VALUES (?, ?, ?, ?)');
    return events.map(event => {
      const entry = { id: uuidv4(), event };
      const kind = event instanceof IntegrationEvent ? 'integration' : 'domain';
      insert.run(entry.id, kind, event.name, JSON.stringify(event.payload ?? null));
      return entry;
    });
  }

  async pending(): Promise<OutboxEntry[]> {
    const rows = await this.database.exclusive(
      connection =>
        connection.prepare('SELECT id, kind, name, payload FROM outbox ORDER BY seq').all() as unknown as Array<{
          id: string;
          kind: string;
          name: string;
          payload: string;
        }>,
    );
    return rows.map(({ id, kind, name, payload }) => {
      const Type = kind === 'integration' ? IntegrationEvent : DomainEvent;
      return { id, event: new Type({ name, payload: JSON.parse(payload) }) };
    });
  }

  async markPublished(id: string): Promise<void> {
    await this.database.exclusive(connection => connection.prepare('DELETE FROM outbox WHERE id = ?').run(id));
  }
}
