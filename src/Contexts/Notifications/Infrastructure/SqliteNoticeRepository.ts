import { IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { createNoticesTables } from '@Contexts/Notifications/Infrastructure/NoticesTables';

/** The notices, in the application's file. It runs inside the reaction's transaction, which holds the file. */
export class SqliteNoticeRepository implements INoticeRepository {
  constructor(private database: SqliteDatabase) {
    createNoticesTables(database);
  }

  async save(notice: Notice): Promise<IResult> {
    this.database.run(
      'INSERT INTO notices (id, recipient, group_id, expense_id, amount, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
      notice._id.value,
      notice.recipient.value,
      notice.groupId.value,
      notice.expenseId.value,
      notice.amount,
      notice.at.toISOString(),
    );
    return Result.ok();
  }
}
