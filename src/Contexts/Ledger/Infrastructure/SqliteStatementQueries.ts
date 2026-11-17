import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IStatementQueries } from '@Contexts/Ledger/Application/Ports/IStatementQueries';
import { StatementLine } from '@Contexts/Ledger/Application/ReadModel/StatementReadModel';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/** What the screens read of a member's statement, from the SQLite file, outside any transaction. */
export class SqliteStatementQueries implements IStatementQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  entriesOf(groupId: string, memberId: string): Promise<StatementLine[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          `SELECT e.id AS expenseId, e.date, e.description,
                  CASE WHEN e.paid_by = ? THEN e.amount ELSE 0 END AS paid,
                  COALESCE((SELECT s.amount FROM ledger_expense_shares s
                             WHERE s.expense_id = e.id AND s.member_id = ?), 0) AS share
             FROM ledger_expenses e
            WHERE e.group_id = ?
              AND (e.paid_by = ? OR EXISTS (SELECT 1 FROM ledger_expense_shares s
                                             WHERE s.expense_id = e.id AND s.member_id = ?))
            ORDER BY e.date ASC, e.recorded_at ASC, e.rowid ASC`,
        )
        .all(memberId, memberId, groupId, memberId, memberId) as unknown as StatementLine[];
      return rows.map(row => ({ ...row, paid: Number(row.paid), share: Number(row.share) }));
    });
  }
}
