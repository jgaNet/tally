import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { SharesOfMonth } from '@Contexts/Ledger/Domain/Insight/DTOs';
import { IInsightQueries } from '@Contexts/Ledger/Domain/Insight/Ports/IInsightQueries';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { prepareLedgerSchema } from '@Contexts/Ledger/Infrastructure/PostgresExpenseRepository';

/**
 * The spending insights over PostgreSQL (request 37, docs/adr/0037): a person's shares, summed by group, month and category, read from the
 * ledger's own tables. A deleted expense has no rows; the month is the first seven characters of its date, a day in UTC.
 */
export class PostgresInsightQueries implements IInsightQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareLedgerSchema);
  }

  async sharesOf(memberId: string, groupIds: string[]): Promise<SharesOfMonth[]> {
    if (groupIds.length === 0) return [];
    return this.database.exclusive(async () => {
      const rows = await this.database.all<{ group_id: string; month: string; category: string; amount: number }>(
        `SELECT e.group_id, substr(e.date, 1, 7) AS month, e.category, SUM(s.amount) AS amount
           FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
          WHERE s.member_id = ? AND e.group_id IN (${groupIds.map(() => '?').join(', ')})
          GROUP BY e.group_id, substr(e.date, 1, 7), e.category`,
        [memberId, ...groupIds],
      );
      return rows.map(row => ({
        groupId: String(row.group_id),
        month: String(row.month),
        category: String(row.category) as Category,
        amount: Number(row.amount),
      }));
    });
  }
}
