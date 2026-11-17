import { v4 as uuidv4 } from 'uuid';

import { CommandEvent, DomainEvent, Event, IntegrationEvent } from '@Architecture/Domain';
import { Outbox, OutboxEntry } from '@Architecture/Application';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

type Kind = 'command' | 'domain' | 'integration' | 'event';

interface Row {
  id: string;
  kind: Kind;
  name: string;
  payload: string;
}

/**
 * The outbox in the same file as the state it describes: `append` runs inside the transaction that saves the
 * aggregate, so both are durable or neither is, and what a crash kept from being published is still here at the
 * next start. An entry leaves it when every subscriber has taken it.
 *
 * An event is kept as its kind, its name and its payload as JSON, and comes back as an event of that kind and name.
 */
export class SqliteOutbox implements Outbox {
  constructor(private database: SqliteDatabase) {
    database.exec(`CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      payload TEXT NOT NULL
    )`);
  }

  /** Called inside the transaction of the aggregate's save: it takes no lock of its own. */
  async append(events: Event<unknown>[]): Promise<OutboxEntry[]> {
    return events.map(event => {
      const entry = { id: uuidv4(), event };
      this.database.run(
        'INSERT INTO outbox (id, kind, name, payload) VALUES (?, ?, ?, ?)',
        entry.id,
        kindOf(event),
        event.name,
        JSON.stringify(event.payload ?? null),
      );
      return entry;
    });
  }

  async pending(): Promise<OutboxEntry[]> {
    const rows = await this.database.exclusive(() =>
      this.database.all<Row>('SELECT id, kind, name, payload FROM outbox ORDER BY rowid'),
    );
    return rows.map(row => ({ id: row.id, event: eventOf(row) }));
  }

  async markPublished(id: string): Promise<void> {
    await this.database.exclusive(() => this.database.run('DELETE FROM outbox WHERE id = ?', id));
  }
}

function kindOf(event: Event<unknown>): Kind {
  if (event instanceof CommandEvent) return 'command';
  if (event instanceof DomainEvent) return 'domain';
  if (event instanceof IntegrationEvent) return 'integration';
  return 'event';
}

function eventOf({ kind, name, payload }: Row): Event<unknown> {
  const made = { name, payload: JSON.parse(payload) as unknown };
  if (kind === 'command') return new CommandEvent(made);
  if (kind === 'domain') return new DomainEvent(made);
  if (kind === 'integration') return new IntegrationEvent(made);
  return new Event(made);
}
