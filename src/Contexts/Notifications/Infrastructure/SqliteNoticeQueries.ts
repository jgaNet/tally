import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { NoticeView } from '@Contexts/Notifications/Domain/Notice/DTOs';
import { INoticeQueries } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeQueries';
import { prepareNoticeSchema } from '@Contexts/Notifications/Infrastructure/SqliteNotices';

/** The read side of the notices, over the same table as their store (request 17). */
export class SqliteNoticeQueries implements INoticeQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareNoticeSchema);
  }

  async noticesOf(accountId: string): Promise<NoticeView[]> {
    return this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(
          'SELECT id, kind, group_id, expense_id, amount, at FROM notices WHERE account_id = ? ORDER BY at DESC, rowid DESC',
        )
        .all(accountId) as Array<{
        id: string;
        group_id: string;
        expense_id: string;
        amount: number;
        at: string;
      }>;
      return rows.map(row => ({
        id: String(row.id),
        kind: 'expense' as const,
        groupId: String(row.group_id),
        expenseId: String(row.expense_id),
        amount: Number(row.amount),
        at: String(row.at),
      }));
    });
  }
}
