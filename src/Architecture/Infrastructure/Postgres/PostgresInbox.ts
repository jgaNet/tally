import type { Inbox } from '@Architecture/Application/EventBus';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * The bus's inbox in the application's database (docs/adr/0029): a table, `inbox`, of the subscribers and the messages
 * they handled. Kept across restarts, and shared by every server on the database, so a message a subscriber handled
 * before a restart is not handed to it again.
 */
export class PostgresInbox implements Inbox {
  constructor(private readonly database: PostgresDatabase) {}

  // The inbox is written on a connection of its own, not under the process's turn: the bus asks it while a relay runs,
  // which may be inside a transaction of this process that holds the turn. One row, idempotent, needs no transaction.
  async has(subscriber: string, messageId: string): Promise<boolean> {
    const { rowCount } = await this.database.pooled(
      'SELECT 1 AS found FROM inbox WHERE subscriber = ? AND message_id = ?',
      [subscriber, messageId],
    );
    return (rowCount ?? 0) > 0;
  }

  async record(subscriber: string, messageId: string): Promise<void> {
    await this.database.pooled(
      'INSERT INTO inbox (subscriber, message_id) VALUES (?, ?) ON CONFLICT (subscriber, message_id) DO NOTHING',
      [subscriber, messageId],
    );
  }
}
