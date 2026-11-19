import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IInsightQueries } from '@Contexts/Ledger/Application/Ports/IInsightQueries';
import { GroupShareReadModel } from '@Contexts/Ledger/Application/ReadModel/InsightReadModel';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/** What the screens read of an account's spending, from the PostgreSQL database, outside any transaction (request 37). */
export class PostgresInsightQueries implements IInsightQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  sharesOf(accountId: string, groupIds: string[]): Promise<GroupShareReadModel[]> {
    if (groupIds.length === 0) return Promise.resolve([]);
    const marks = groupIds.map(() => '?').join(', ');
    return this.database.exclusive(async connection => {
      const rows = await connection.rows<Omit<GroupShareReadModel, 'amount'> & { amount: number | string }>(
        `SELECT e.group_id AS "groupId", substr(e.date, 1, 7) AS month, c.category, SUM(s.amount) AS amount
           FROM ledger_expense_shares s
           JOIN ledger_expenses e ON e.id = s.expense_id
           JOIN ledger_expense_categories c ON c.expense_id = e.id
          WHERE s.member_id = ? AND e.group_id IN (${marks})
          GROUP BY e.group_id, substr(e.date, 1, 7), c.category`,
        accountId,
        ...groupIds,
      );
      return rows.map(row => ({ ...row, amount: Number(row.amount) }) as GroupShareReadModel);
    });
  }
}
