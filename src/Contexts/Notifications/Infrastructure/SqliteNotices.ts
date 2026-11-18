import { StatementSync } from 'node:sqlite';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeStore, NoticeView } from '@Contexts/Notifications/Application/INoticeStore';

import { NoticesDatabase } from './NoticesDatabase';

type NoticeRow = {
  id: string;
  kind: string;
  group_id: string;
  expense_id: string;
  category: string | null;
  month: string | null;
  budget: number | null;
  amount: number;
  at: string;
};

/** The `INSERT` of a notice, whatever its kind: a reminder has no expense, and an expense's notice no category, month or budget. */
export const INSERT_NOTICE =
  'INSERT INTO notifications_notices (id, member_id, kind, group_id, expense_id, category, month, budget, amount, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/** Writes one notice with a prepared `INSERT` of the notices table; a reminder's expense is kept as ''. */
export function insertNotice(statement: StatementSync, notice: Notice): void {
  const { id, memberId, kind, groupId, expenseId, category, month, budget, amount, at } = notice.toSnapshot();
  statement.run(
    id,
    memberId,
    kind,
    groupId,
    expenseId ?? '',
    category ?? null,
    month ?? null,
    budget ?? null,
    amount,
    at,
  );
}

/**
 * The notices in SQLite. `insert` writes the notices of one expense in one transaction, so that a reaction that fails part-way
 * leaves none of them; `noticesOf` reads a member's, the most recent first and, for the same instant, the one written last.
 */
export class SqliteNotices implements INoticeStore {
  constructor(private readonly database: NoticesDatabase) {}

  async insert(notices: Notice[]): Promise<void> {
    if (notices.length === 0) return;
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      const statement = connection.prepare(INSERT_NOTICE);
      for (const notice of notices) {
        insertNotice(statement, notice);
      }
    });
  }

  async noticesOf(memberId: string): Promise<NoticeView[]> {
    const rows = this.database.connection
      .prepare(
        'SELECT id, kind, group_id, expense_id, category, month, budget, amount, at FROM notifications_notices WHERE member_id = ? ORDER BY at DESC, seq DESC',
      )
      .all(memberId) as NoticeRow[];
    return rows.map(row =>
      row.kind === 'budget'
        ? {
            id: row.id,
            kind: 'budget',
            groupId: row.group_id,
            category: row.category!,
            month: row.month!,
            budget: row.budget!,
            amount: row.amount,
            at: row.at,
          }
        : row.kind === 'reminder'
          ? { id: row.id, kind: 'reminder', groupId: row.group_id, amount: row.amount, at: row.at }
          : {
              id: row.id,
              kind: 'expense',
              groupId: row.group_id,
              expenseId: row.expense_id,
              amount: row.amount,
              at: row.at,
            },
    );
  }
}
