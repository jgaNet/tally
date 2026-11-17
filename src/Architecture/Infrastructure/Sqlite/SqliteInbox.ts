import { Inbox } from '@Architecture/Application/Inbox';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

/**
 * The inbox in the database (ADR 12): a row per handled message and subscription, written in the reaction's transaction, so a
 * rollback drops the mark with the writes it describes. Both calls run on the writer, the connection that holds the transaction.
 */
export class SqliteInbox implements Inbox {
  constructor(private readonly database: SqliteDatabase) {}

  async has(subscription: string, messageId: string): Promise<boolean> {
    const row = this.database.writer
      .prepare('SELECT 1 AS handled FROM inbox WHERE subscription = ? AND message_id = ?')
      .get(subscription, messageId);
    return row !== undefined;
  }

  async record(subscription: string, messageId: string): Promise<void> {
    this.database.writer
      .prepare('INSERT OR IGNORE INTO inbox (subscription, message_id) VALUES (?, ?)')
      .run(subscription, messageId);
  }
}
