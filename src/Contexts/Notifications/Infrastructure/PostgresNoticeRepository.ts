import { IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { NOTICE_STATEMENTS } from '@Contexts/Notifications/Infrastructure/notices.schema';

/** The notices' repository over the PostgreSQL database; used inside the reaction's or the sweep's transaction, which holds the connection. */
export class PostgresNoticeRepository implements INoticeRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(NOTICE_STATEMENTS);
  }

  async save(notice: Notice): Promise<IResult> {
    const { id, memberId, groupId, expenseId, kind, amount, at, category, month, budget } = notice.toSnapshot();
    await this.database.connection.run(
      `INSERT INTO notifications_notices (id, member_id, group_id, expense_id, kind, amount, at, category, month, budget)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      memberId,
      groupId,
      expenseId ?? null,
      kind,
      amount,
      at,
      category ?? null,
      month ?? null,
      budget ?? null,
    );
    return Result.ok();
  }
}
