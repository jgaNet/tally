import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { GroupSpending, ISpendingQueries } from '@Contexts/Ledger/Application/Ports/ISpendingQueries';
import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface Row {
  group_id: string;
  spent_month: string;
  category: CategoryName;
  amount: number | string;
}

/**
 * A person's shares, summed by group, month and category, over Ledger's own expenses (request 37). `sharesOf` is read by a query,
 * outside any transaction, so it waits for the one in progress. The sum is a bigint the database returns as text; it is read as a number.
 */
export class PostgresSpendingReadModels implements ISpendingQueries {
  constructor(private database: PostgresDatabase) {
    createLedgerTables(database);
  }

  async sharesOf(memberId: string, groupIds: string[]): Promise<GroupSpending[]> {
    if (groupIds.length === 0) return [];
    const placeholders = groupIds.map(() => '?').join(', ');
    return this.database.exclusive(async () => {
      const rows = await this.database.all<Row>(
        `SELECT e.group_id, substr(e.spent_on, 1, 7) AS spent_month, e.category, SUM(s.amount) AS amount
         FROM expenses e JOIN expense_shares s ON s.expense_id = e.id
         WHERE s.member_id = ? AND e.group_id IN (${placeholders})
         GROUP BY e.group_id, substr(e.spent_on, 1, 7), e.category`,
        memberId,
        ...groupIds,
      );
      return rows.map(row => ({
        groupId: row.group_id,
        month: row.spent_month,
        category: row.category,
        amount: Number(row.amount),
      }));
    });
  }
}
