import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeStore, NoticeView } from '@Contexts/Notifications/Application/INoticeStore';

import { NoticesDatabase } from './NoticesDatabase';

type NoticeRow = { id: string; group_id: string; expense_id: string; amount: number; at: string };

/**
 * The notices in SQLite. `insert` writes the notices of one expense in one transaction, so that a reaction that fails part-way
 * leaves none of them; `noticesOf` reads a member's, the most recent first and, for the same instant, the one written last.
 */
export class SqliteNotices implements INoticeStore {
  constructor(private readonly database: NoticesDatabase) {}

  async insert(notices: Notice[]): Promise<void> {
    if (notices.length === 0) return;
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      const statement = connection.prepare(
        'INSERT INTO notifications_notices (id, member_id, group_id, expense_id, amount, at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const notice of notices) {
        const { id, memberId, groupId, expenseId, amount, at } = notice.toSnapshot();
        statement.run(id, memberId, groupId, expenseId, amount, at);
      }
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async noticesOf(memberId: string): Promise<NoticeView[]> {
    const rows = this.database.connection
      .prepare(
        'SELECT id, group_id, expense_id, amount, at FROM notifications_notices WHERE member_id = ? ORDER BY at DESC, seq DESC',
      )
      .all(memberId) as NoticeRow[];
    return rows.map(row => ({
      id: row.id,
      kind: 'expense',
      groupId: row.group_id,
      expenseId: row.expense_id,
      amount: row.amount,
      at: row.at,
    }));
  }
}
