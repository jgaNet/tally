import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { INoticeQueries } from '@Contexts/Notifications/Application/Ports/INoticeQueries';
import { NoticeReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticeReadModel';
import { migrateNotices } from '@Contexts/Notifications/Infrastructure/notices.schema';

/** What a member reads of their notices, from the SQLite file, outside any transaction. A reminder has no expense, so none is named. */
export class SqliteNoticeQueries implements INoticeQueries {
  constructor(private readonly database: SqliteDatabase) {
    migrateNotices(database);
  }

  async listFor(memberId: string): Promise<NoticeReadModel[]> {
    const rows = await this.database.exclusive(
      connection =>
        connection
          .prepare(
            `SELECT id, kind, group_id AS groupId, expense_id AS expenseId, amount, at
               FROM notifications_notices
              WHERE member_id = ?
              ORDER BY at DESC, rowid DESC`,
          )
          .all(memberId) as unknown as (Omit<NoticeReadModel, 'expenseId'> & { expenseId: string | null })[],
    );
    return rows.map(({ expenseId, ...notice }) => ({ ...notice, ...(expenseId !== null && { expenseId }) }));
  }
}
