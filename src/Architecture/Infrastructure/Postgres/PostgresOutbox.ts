import { v4 as uuidv4 } from 'uuid';

import { DomainEvent, Event, IntegrationEvent } from '@Architecture/Domain';
import { Outbox, OutboxEntry } from '@Architecture/Application';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * The outbox in the PostgreSQL database (ADR 24, ADR 22). `append()` is called by the unit of work's
 * commit step, inside the transaction, so an entry exists exactly when the state it describes
 * does; `pending()` and `markPublished()` are the relay's, after the commit, and survive a crash:
 * what was not published is published at the next start. An entry published is deleted: what is
 * left is what was not relayed yet, which is what the move from the SQLite file carries over.
 */
export class PostgresOutbox implements Outbox {
  static readonly STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS outbox (
       seq BIGSERIAL PRIMARY KEY,
       id TEXT NOT NULL UNIQUE,
       kind TEXT NOT NULL,
       name TEXT NOT NULL,
       payload TEXT NOT NULL
     )`,
  ];

  constructor(private readonly database: PostgresDatabase) {
    database.migrate(PostgresOutbox.STATEMENTS);
  }

  /** Inside the transaction that holds the connection. */
  async append(events: Event<unknown>[]): Promise<OutboxEntry[]> {
    const entries: OutboxEntry[] = [];
    for (const event of events) {
      const entry = { id: uuidv4(), event };
      const kind = event instanceof IntegrationEvent ? 'integration' : 'domain';
      await this.database.connection.run(
        'INSERT INTO outbox (id, kind, name, payload) VALUES (?, ?, ?, ?)',
        entry.id,
        kind,
        event.name,
        JSON.stringify(event.payload ?? null),
      );
      entries.push(entry);
    }
    return entries;
  }

  async pending(): Promise<OutboxEntry[]> {
    const rows = await this.database.exclusive(connection =>
      connection.rows<{ id: string; kind: string; name: string; payload: string }>(
        'SELECT id, kind, name, payload FROM outbox ORDER BY seq',
      ),
    );
    return rows.map(({ id, kind, name, payload }) => {
      const Type = kind === 'integration' ? IntegrationEvent : DomainEvent;
      return { id, event: new Type({ name, payload: JSON.parse(payload) }) };
    });
  }

  async markPublished(id: string): Promise<void> {
    await this.database.exclusive(connection => connection.run('DELETE FROM outbox WHERE id = ?', id));
  }
}
