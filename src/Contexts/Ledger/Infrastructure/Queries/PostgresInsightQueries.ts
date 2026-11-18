import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { GroupSpendingRow, IInsightQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IInsightQueries';
import { defineExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresExpenseRepository';

/**
 * The read side of a person's spending over the same database (request 37): the account's shares, in the expenses of the
 * groups given, grouped by group, month (the first seven characters of the day, in UTC) and category. An expense's shares are in
 * its group's currency, so the sums are too. A SUM is a bigint, which the driver returns as a string: it is read back as a number.
 */
export class PostgresInsightQueries implements IInsightQueries {
  constructor(private database: PostgresDatabase) {
    defineExpensesTables(database);
  }

  async sharesOf(accountId: string, groupIds: string[]): Promise<GroupSpendingRow[]> {
    if (groupIds.length === 0) return [];
    const placeholders = groupIds.map(() => '?').join(', ');
    const rows = await this.database.all<{
      group_id: string;
      month: string;
      category: Category;
      amount: string | number;
    }>(
      `SELECT e.group_id, substr(e.spent_on, 1, 7) AS month, e.category, SUM(s.amount) AS amount
         FROM expense_shares s
         JOIN expenses e ON e.id = s.expense_id
        WHERE s.member_id = ? AND e.group_id IN (${placeholders})
        GROUP BY e.group_id, substr(e.spent_on, 1, 7), e.category`,
      [accountId, ...groupIds],
    );
    return rows.map(row => ({
      groupId: row.group_id,
      month: row.month,
      category: row.category,
      amount: Number(row.amount),
    }));
  }
}
