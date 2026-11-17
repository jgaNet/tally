import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { INoticeQueries } from '@Contexts/Notifications/Application/Ports/INoticeQueries';
import { NoticeReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticeReadModel';
import { NOTICE_STATEMENTS } from '@Contexts/Notifications/Infrastructure/notices.schema';

/** What a member reads of their notices, from the SQLite file, outside any transaction. */
export class SqliteNoticeQueries implements INoticeQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(NOTICE_STATEMENTS);
  }

  listFor(memberId: string): Promise<NoticeReadModel[]> {
    return this.database.exclusive(
      connection =>
        connection
          .prepare(
            `SELECT id, kind, group_id AS groupId, expense_id AS expenseId, amount, at
               FROM notifications_notices
              WHERE member_id = ?
              ORDER BY at DESC, rowid DESC`,
          )
          .all(memberId) as unknown as NoticeReadModel[],
    );
  }
}
