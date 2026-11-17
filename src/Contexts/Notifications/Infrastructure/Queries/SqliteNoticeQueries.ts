import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { INoticeQueries, NoticeView } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeQueries';
import { createNoticeTables } from '@Contexts/Notifications/Infrastructure/Repositories/SqliteNoticeRepository';

/** A person's notices, read from the table the repository keeps: the most recent first, the last made first at the same instant. */
export class SqliteNoticeQueries implements INoticeQueries {
  constructor(private database: SqliteDatabase) {
    createNoticeTables(database);
  }

  async ofRecipient(recipient: string): Promise<NoticeView[]> {
    const rows = this.database.connection
      .prepare(
        'SELECT id, kind, group_id, expense_id, amount, at FROM notices WHERE recipient = ? ORDER BY at DESC, rowid DESC',
      )
      .all(recipient) as {
      id: string;
      kind: 'expense' | 'reminder';
      group_id: string;
      expense_id: string | null;
      amount: number;
      at: string;
    }[];
    return rows.map(row => {
      const view: NoticeView = { id: row.id, kind: row.kind, groupId: row.group_id, amount: row.amount, at: row.at };
      return row.expense_id === null ? view : { ...view, expenseId: row.expense_id };
    });
  }
}
