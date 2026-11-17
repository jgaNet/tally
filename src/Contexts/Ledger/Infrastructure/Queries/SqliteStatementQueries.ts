import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IStatementQueries, StatementRow } from '@Contexts/Ledger/Domain/Expense/Ports/IStatementQueries';
import { createExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';

interface StatementRowRecord {
  expense_id: string;
  spent_on: string;
  description: string;
  paid: number;
  share: number;
}

/**
 * The statement read model over the same file: the expenses a member paid or is in the split of, read from the expenses
 * and their shares as they are now. Nothing is stored per entry.
 */
export class SqliteStatementQueries implements IStatementQueries {
  constructor(private database: SqliteDatabase) {
    createExpensesTables(database);
  }

  rowsOf(groupId: string, memberId: string): Promise<StatementRow[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          `SELECT e.id AS expense_id, e.spent_on, e.description,
                  CASE WHEN e.paid_by = :member THEN e.amount ELSE 0 END AS paid,
                  COALESCE((SELECT SUM(s.amount) FROM expense_shares s
                             WHERE s.expense_id = e.id AND s.member_id = :member), 0) AS share
             FROM expenses e
            WHERE e.group_id = :group
              AND (e.paid_by = :member
                   OR EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = :member))
            ORDER BY e.spent_on ASC, e.recorded_seq ASC`,
        )
        .all({ group: groupId, member: memberId }) as unknown as StatementRowRecord[];
      return rows.map(row => ({
        expenseId: row.expense_id,
        date: row.spent_on,
        description: row.description,
        paid: row.paid,
        share: row.share,
      }));
    });
  }
}
