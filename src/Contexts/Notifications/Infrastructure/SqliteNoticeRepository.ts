import { IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { NOTICE_STATEMENTS } from '@Contexts/Notifications/Infrastructure/notices.schema';

/** The notices' repository over the SQLite file; used inside the reaction's transaction, which holds the connection. */
export class SqliteNoticeRepository implements INoticeRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(NOTICE_STATEMENTS);
  }

  async save(notice: Notice): Promise<IResult> {
    const { id, memberId, groupId, expenseId, kind, amount, at } = notice.toSnapshot();
    this.database.connection
      .prepare(
        `INSERT INTO notifications_notices (id, member_id, group_id, expense_id, kind, amount, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, memberId, groupId, expenseId, kind, amount, at);
    return Result.ok();
  }
}
