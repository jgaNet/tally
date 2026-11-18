import { IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { createNoticesTables } from '@Contexts/Notifications/Infrastructure/NoticesTables';

/** The notices, in the application's file. It runs inside the reaction's transaction, which holds the file. */
export class PostgresNoticeRepository implements INoticeRepository {
  constructor(private database: PostgresDatabase) {
    createNoticesTables(database);
  }

  async save(notice: Notice): Promise<IResult> {
    await this.database.run(
      'INSERT INTO notices (id, recipient, group_id, kind, expense_id, amount, recorded_at, category, month, budget) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      notice._id.value,
      notice.recipient.value,
      notice.groupId.value,
      notice.kind,
      notice.expenseId?.value ?? null,
      notice.amount,
      notice.at.toISOString(),
      notice.budgetPassed?.category ?? null,
      notice.budgetPassed?.month ?? null,
      notice.budgetPassed?.budget ?? null,
    );
    return Result.ok();
  }
}
