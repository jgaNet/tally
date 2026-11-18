import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IStatementQueries } from '@Contexts/Ledger/Application/Ports/IStatementQueries';
import { ExpenseLine } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/** What the screens read of a member's statement, from the PostgreSQL database, outside any transaction. */
export class PostgresStatementQueries implements IStatementQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  entriesOf(groupId: string, memberId: string): Promise<ExpenseLine[]> {
    return this.database.exclusive(async connection => {
      const rows = await connection.rows<Omit<ExpenseLine, 'kind'>>(
        `SELECT e.id AS "expenseId", e.date, e.description, e.recorded_at AS at,
                  CASE WHEN e.paid_by = ? THEN e.amount ELSE 0 END AS paid,
                  COALESCE((SELECT s.amount FROM ledger_expense_shares s
                             WHERE s.expense_id = e.id AND s.member_id = ?), 0) AS share
             FROM ledger_expenses e
            WHERE e.group_id = ?
              AND (e.paid_by = ? OR EXISTS (SELECT 1 FROM ledger_expense_shares s
                                             WHERE s.expense_id = e.id AND s.member_id = ?))
            ORDER BY e.date ASC, e.recorded_at ASC, e.rowid ASC`,
        memberId,
        memberId,
        groupId,
        memberId,
        memberId,
      );
      return rows.map(row => ({
        kind: 'expense' as const,
        ...row,
        paid: Number(row.paid),
        share: Number(row.share),
      }));
    });
  }
}
