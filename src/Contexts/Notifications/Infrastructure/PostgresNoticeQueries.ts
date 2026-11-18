import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { INoticeQueries } from '@Contexts/Notifications/Application/Ports/INoticeQueries';
import { NoticeReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticeReadModel';
import { NOTICE_STATEMENTS } from '@Contexts/Notifications/Infrastructure/notices.schema';

/** What a member reads of their notices, from the PostgreSQL database, outside any transaction. A reminder has no expense, so none is named. */
export class PostgresNoticeQueries implements INoticeQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(NOTICE_STATEMENTS);
  }

  async listFor(memberId: string): Promise<NoticeReadModel[]> {
    const rows = await this.database.exclusive(connection =>
      connection.rows<
        Omit<NoticeReadModel, 'expenseId' | 'category' | 'month' | 'budget'> & {
          expenseId: string | null;
          category: string | null;
          month: string | null;
          budget: number | null;
        }
      >(
        `SELECT id, kind, group_id AS "groupId", expense_id AS "expenseId", amount, at,
                category, month, budget
           FROM notifications_notices
          WHERE member_id = ?
          ORDER BY at DESC, rowid DESC`,
        memberId,
      ),
    );
    return rows.map(({ expenseId, category, month, budget, ...notice }) => ({
      ...notice,
      ...(expenseId !== null && { expenseId }),
      ...(category !== null && { category }),
      ...(month !== null && { month }),
      ...(budget !== null && { budget }),
    }));
  }
}
