import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { NoticeKind, NoticeView } from '@Contexts/Notifications/Domain/Notice/DTOs';
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
          'SELECT id, kind, group_id, expense_id, category, month, budget, amount, at FROM notices WHERE account_id = ? ORDER BY at DESC, rowid DESC',
        )
        .all(accountId) as Array<{
        id: string;
        kind: string;
        group_id: string;
        expense_id: string | null;
        category: string | null;
        month: string | null;
        budget: number | null;
        amount: number;
        at: string;
      }>;
      return rows.map((row): NoticeView => {
        const kind: NoticeKind = row.kind === 'reminder' ? 'reminder' : row.kind === 'budget' ? 'budget' : 'expense';
        return {
          id: String(row.id),
          kind,
          groupId: String(row.group_id),
          // A reminder names no expense: the answer omits the field, rather than naming a null (request 18). A budget names no expense either.
          ...(row.expense_id === null ? {} : { expenseId: String(row.expense_id) }),
          // A budget's notice names its category, month and budget (request 24); no other kind does.
          ...(kind === 'budget'
            ? { category: String(row.category), month: String(row.month), budget: Number(row.budget) }
            : {}),
          amount: Number(row.amount),
          at: String(row.at),
        };
      });
    });
  }
}
