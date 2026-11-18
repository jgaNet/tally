import { IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { migrateNotices } from '@Contexts/Notifications/Infrastructure/notices.schema';

/** The notices' repository over the SQLite file; used inside the reaction's or the sweep's transaction, which holds the connection. */
export class SqliteNoticeRepository implements INoticeRepository {
  constructor(private readonly database: SqliteDatabase) {
    migrateNotices(database);
  }

  async save(notice: Notice): Promise<IResult> {
    const { id, memberId, groupId, expenseId, kind, amount, at, category, month, budget } = notice.toSnapshot();
    this.database.connection
      .prepare(
        `INSERT INTO notifications_notices (id, member_id, group_id, expense_id, kind, amount, at, category, month, budget)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, memberId, groupId, expenseId ?? null, kind, amount, at, category ?? null, month ?? null, budget ?? null);
    return Result.ok();
  }
}
