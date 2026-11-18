import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { NoticeKind } from '@Contexts/Notifications/Domain/Notice/DTOs';
import { INoticeQueries, NoticeView } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeQueries';
import { createNoticeTables } from '@Contexts/Notifications/Infrastructure/Repositories/PostgresNoticeRepository';

interface NoticeRow {
  id: string;
  kind: NoticeKind;
  group_id: string;
  expense_id: string | null;
  amount: number;
  at: string;
  category: string | null;
  month: string | null;
  budget_amount: number | null;
}

/** A person's notices, read from the table the repository keeps: the most recent first, the last made first at the same instant. */
export class PostgresNoticeQueries implements INoticeQueries {
  constructor(private database: PostgresDatabase) {
    createNoticeTables(database);
  }

  async ofRecipient(recipient: string): Promise<NoticeView[]> {
    const rows = await this.database.all<NoticeRow>(
      'SELECT id, kind, group_id, expense_id, amount, at, category, month, budget_amount FROM notices WHERE recipient = ? ORDER BY at DESC, seq DESC',
      [recipient],
    );
    return rows.map(row => {
      const view: NoticeView = { id: row.id, kind: row.kind, groupId: row.group_id, amount: row.amount, at: row.at };
      if (row.expense_id !== null) view.expenseId = row.expense_id;
      if (row.kind === 'budget' && row.category !== null && row.month !== null && row.budget_amount !== null) {
        view.category = row.category;
        view.month = row.month;
        view.budget = row.budget_amount;
      }
      return view;
    });
  }
}
