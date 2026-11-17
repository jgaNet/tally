import { StatementSync } from 'node:sqlite';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { INoticeStore, NoticeView } from '@Contexts/Notifications/Application/INoticeStore';

import { NoticesDatabase } from './NoticesDatabase';

type NoticeRow = { id: string; kind: string; group_id: string; expense_id: string; amount: number; at: string };

/** Writes one notice with a prepared `INSERT` of the notices table; a reminder's expense is kept as ''. */
export function insertNotice(statement: StatementSync, notice: Notice): void {
  const { id, memberId, kind, groupId, expenseId, amount, at } = notice.toSnapshot();
  statement.run(id, memberId, kind, groupId, expenseId ?? '', amount, at);
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
    connection.exec('BEGIN IMMEDIATE');
    try {
      const statement = connection.prepare(
        'INSERT INTO notifications_notices (id, member_id, kind, group_id, expense_id, amount, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const notice of notices) {
        insertNotice(statement, notice);
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
        'SELECT id, kind, group_id, expense_id, amount, at FROM notifications_notices WHERE member_id = ? ORDER BY at DESC, seq DESC',
      )
      .all(memberId) as NoticeRow[];
    return rows.map(row =>
      row.kind === 'reminder'
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
