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
  'INSERT INTO notifications_notices (id, member_id, kind, group_id, expense_id, category, month, budget, amount, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)';

/** Writes one notice with the `INSERT` of the notices table, through `run`; a reminder's expense is kept as ''. */
export async function insertNotice(
  run: (text: string, params: unknown[]) => Promise<number>,
  notice: Notice,
): Promise<void> {
  const { id, memberId, kind, groupId, expenseId, category, month, budget, amount, at } = notice.toSnapshot();
  await run(INSERT_NOTICE, [
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
  ]);
}

/**
 * The notices in PostgreSQL. `insert` writes the notices of one expense in one transaction, so that a reaction that fails part-way
 * leaves none of them; `noticesOf` reads a member's, the most recent first and, for the same instant, the one written last.
 */
export class SqliteNotices implements INoticeStore {
  constructor(private readonly database: NoticesDatabase) {}

  async insert(notices: Notice[]): Promise<void> {
    if (notices.length === 0) return;
    await this.database.transaction(async () => {
      for (const notice of notices) {
        await insertNotice((text, params) => this.database.execute(text, params), notice);
      }
    });
  }

  async noticesOf(memberId: string): Promise<NoticeView[]> {
    const rows = await this.database.rows<NoticeRow>(
      'SELECT id, kind, group_id, expense_id, category, month, budget, amount, at FROM notifications_notices WHERE member_id = $1 ORDER BY at DESC, seq DESC',
      [memberId],
    );
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
