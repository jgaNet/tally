import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { INoticeQueries } from '@Contexts/Notifications/Application/Ports/INoticeQueries';
import { NoticeReadModel } from '@Contexts/Notifications/Application/ReadModel/NoticeReadModel';
import { createNoticesTables } from '@Contexts/Notifications/Infrastructure/NoticesTables';

interface Row {
  id: string;
  kind: 'expense' | 'reminder';
  group_id: string;
  expense_id: string | null;
  amount: number;
  recorded_at: string;
}

/** The notices' read models: read outside any transaction, so it waits for the one in progress. Latest first, then by recording order. */
export class SqliteNoticeReadModels implements INoticeQueries {
  constructor(private database: SqliteDatabase) {
    createNoticesTables(database);
  }

  async ofRecipient(recipientId: string): Promise<NoticeReadModel[]> {
    return this.database.exclusive(() =>
      this.database
        .all<Row>(
          `SELECT id, kind, group_id, expense_id, amount, recorded_at FROM notices
           WHERE recipient = ? ORDER BY recorded_at DESC, rowid DESC`,
          recipientId,
        )
        .map((row): NoticeReadModel =>
          row.kind === 'reminder'
            ? { id: row.id, kind: 'reminder', groupId: row.group_id, amount: row.amount, at: row.recorded_at }
            : {
                id: row.id,
                kind: 'expense',
                groupId: row.group_id,
                expenseId: row.expense_id as string,
                amount: row.amount,
                at: row.recorded_at,
              },
        ),
    );
  }
}
