import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { ExpenseView, IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { defineExpensesTables } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresExpenseRepository';

interface ExpenseViewRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  split_kind: SplitKind;
  version: number;
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
  category: Category;
}

/** The read side of expenses over the same database: each expense as recorded, its shares in the order of the split. */
export class PostgresExpenseQueries implements IExpenseQueries {
  constructor(private database: PostgresDatabase) {
    defineExpensesTables(database);
  }

  async findExpense(id: string): Promise<ExpenseView | null> {
    const row = await this.database.get<ExpenseViewRow>('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!row) return null;

    const shares = await this.database.all<ShareRecord>(
      'SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position',
      [id],
    );
    return toView(row, shares);
  }

  async listGroupExpenses(groupId: string): Promise<ExpenseView[]> {
    // recorded_seq is NULL only for rows stored before it existed: NULLS LAST keeps them after the numbered ones.
    const rows = await this.database.all<ExpenseViewRow>(
      'SELECT * FROM expenses WHERE group_id = ? ORDER BY spent_on DESC, recorded_seq DESC NULLS LAST',
      [groupId],
    );
    const shares = await this.database.all<ShareRecord & { expense_id: string }>(
      `SELECT s.expense_id, s.member_id, s.amount FROM expense_shares s
         JOIN expenses e ON e.id = s.expense_id
        WHERE e.group_id = ?
        ORDER BY s.expense_id, s.position`,
      [groupId],
    );

    const byExpense = new Map<string, ShareRecord[]>();
    for (const share of shares) {
      const list = byExpense.get(share.expense_id) ?? [];
      list.push(share);
      byExpense.set(share.expense_id, list);
    }
    return rows.map(row => toView(row, byExpense.get(row.id) ?? []));
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
    category: row.category,
    version: row.version,
    // An expense in the group's currency reads without `original`, as the expenses recorded before it do.
    ...(row.original_currency === null
      ? {}
      : {
          original: {
            currency: row.original_currency,
            amount: row.original_amount ?? 0,
            rate: row.original_rate ?? '',
          },
        }),
  };
}
