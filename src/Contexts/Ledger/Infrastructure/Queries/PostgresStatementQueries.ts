import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ExpenseRow, IStatementQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IStatementQueries';
import { defineExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresExpenseRepository';

interface ExpenseRowRecord {
  expense_id: string;
  spent_on: string;
  description: string;
  paid: number;
  share: number;
  recorded_at: string;
}

/**
 * The statement read model over the same file: the expenses a member paid or is in the split of, read from the expenses
 * and their shares as they are now. Nothing is stored per entry; an expense's recording is read from its audit entry, the
 * one written with it (request 28), and an expense with none is dated at the start of its day.
 */
export class PostgresStatementQueries implements IStatementQueries {
  constructor(private database: PostgresDatabase) {
    defineExpensesTables(database);
  }

  async expenseRowsOf(groupId: string, memberId: string): Promise<ExpenseRow[]> {
    // The member is named by each of its placeholders, in the order they appear in the statement.
    const rows = await this.database.all<ExpenseRowRecord>(
      `SELECT e.id AS expense_id, e.spent_on, e.description,
              CASE WHEN e.paid_by = ? THEN e.amount ELSE 0 END AS paid,
              COALESCE((SELECT SUM(s.amount) FROM expense_shares s
                         WHERE s.expense_id = e.id AND s.member_id = ?), 0) AS share,
              COALESCE((SELECT a.at FROM audit_entries a
                         WHERE a.subject_id = e.id AND a.action = 'expense-recorded' ORDER BY a.seq LIMIT 1),
                       e.spent_on || 'T00:00:00.000Z') AS recorded_at
         FROM expenses e
        WHERE e.group_id = ?
          AND (e.paid_by = ?
               OR EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = ?))
        ORDER BY e.spent_on ASC, e.recorded_seq ASC NULLS FIRST`,
      [memberId, memberId, groupId, memberId, memberId],
    );
    return rows.map(row => ({
      kind: 'expense' as const,
      expenseId: row.expense_id,
      date: row.spent_on,
      description: row.description,
      paid: Number(row.paid),
      // A SUM is a bigint, which the driver returns as a string: it is read back as a number.
      share: Number(row.share),
      at: row.recorded_at,
    }));
  }
}
