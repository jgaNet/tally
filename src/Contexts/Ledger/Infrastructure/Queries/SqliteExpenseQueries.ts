import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';
import { ExpenseView, IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { createExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteExpenseRepository';

interface ExpenseViewRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  split_kind: SplitKind;
  version: number;
}

/** The read side of expenses over the same file: each expense as recorded, its shares in the order of the split. */
export class SqliteExpenseQueries implements IExpenseQueries {
  constructor(private database: SqliteDatabase) {
    createExpensesTables(database);
  }

  findExpense(id: string): Promise<ExpenseView | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as ExpenseViewRow | undefined;
      if (!row) return null;

      const shares = connection
        .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
        .all(id) as unknown as ShareRecord[];
      return toView(row, shares);
    });
  }

  listGroupExpenses(groupId: string): Promise<ExpenseView[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare('SELECT * FROM expenses WHERE group_id = ? ORDER BY spent_on DESC, recorded_seq DESC')
        .all(groupId) as unknown as ExpenseViewRow[];
      const shares = connection
        .prepare(
          `SELECT s.expense_id, s.member_id, s.amount FROM expense_shares s
             JOIN expenses e ON e.id = s.expense_id
            WHERE e.group_id = ?
            ORDER BY s.expense_id, s.position`,
        )
        .all(groupId) as unknown as (ShareRecord & { expense_id: string })[];

      const byExpense = new Map<string, ShareRecord[]>();
      for (const share of shares) {
        const list = byExpense.get(share.expense_id) ?? [];
        list.push(share);
        byExpense.set(share.expense_id, list);
      }
      return rows.map(row => toView(row, byExpense.get(row.id) ?? []));
    });
  }
}

interface ShareRecord {
  member_id: string;
  amount: number;
}

function toView(row: ExpenseViewRow, shares: ShareRecord[]): ExpenseView {
  return {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.spent_on,
    paidBy: row.paid_by,
    shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
    splitKind: row.split_kind,
    version: row.version,
  };
}
