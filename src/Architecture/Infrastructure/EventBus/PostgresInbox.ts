import { PostgresDatabase } from '@Architecture/Infrastructure/DataSources/PostgresDatabase';
import { Inbox } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';

/** The table the bus's inbox keeps what each subscriber has handled in (created by the bootstrap's storage set-up). */
export const INBOX_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS bus_inbox (
    subscriber TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (subscriber, message_id)
  );
`;

/** The bus's record of what it delivered, in PostgreSQL: it survives a restart, so a fact relayed before one is not handed out again. */
export class PostgresInbox implements Inbox {
  constructor(private readonly database: PostgresDatabase) {}

  async has(subscriber: string, messageId: string): Promise<boolean> {
    const { rowCount } = await this.database.query(
      'SELECT 1 FROM bus_inbox WHERE subscriber = $1 AND message_id = $2',
      [subscriber, messageId],
    );
    return (rowCount ?? 0) > 0;
  }

  async add(subscriber: string, messageId: string): Promise<void> {
    await this.database.query('INSERT INTO bus_inbox (subscriber, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      subscriber,
      messageId,
    ]);
  }
}
