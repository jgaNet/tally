import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import {
  IRecurringExpenseQueries,
  RecurringExpenseView,
} from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseQueries';

interface RecurringRow {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  starts_on: string;
  next_on: string;
  split_kind: 'equal' | 'exact' | 'shares';
  category: Category;
}

interface SplitRow {
  member_id: string;
  quantity: number | null;
}

/** The read models of recurring expenses, over the application's SQLite file (request 23). */
export class SqliteRecurringExpenseQueries implements IRecurringExpenseQueries {
  constructor(private database: SqliteDatabase) {}

  async findRecurring(id: string): Promise<RecurringExpenseView | null> {
    const row = this.database.connection.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(id) as
      RecurringRow | undefined;
    return row ? this.viewOf(row) : null;
  }

  async listGroupRecurring(groupId: string): Promise<RecurringExpenseView[]> {
    const rows = this.database.connection
      .prepare('SELECT * FROM recurring_expenses WHERE group_id = ? ORDER BY set_up_seq')
      .all(groupId) as unknown as RecurringRow[];
    return rows.map(row => this.viewOf(row));
  }

  /** The split as it was given: the one of the three keys its kind names, in the order given. */
  private viewOf(row: RecurringRow): RecurringExpenseView {
    const splits = this.database.connection
      .prepare('SELECT member_id, quantity FROM recurring_splits WHERE recurring_id = ? ORDER BY position')
      .all(row.id) as unknown as SplitRow[];
    const view: RecurringExpenseView = {
      id: row.id,
      groupId: row.group_id,
      paidBy: row.paid_by,
      description: row.description,
      amount: row.amount,
      startsOn: row.starts_on,
      next: row.next_on,
      category: row.category,
    };
    if (row.split_kind === 'equal') view.splitBetween = splits.map(split => split.member_id);
    if (row.split_kind === 'exact') {
      view.splitExactly = splits.map(split => ({ memberId: split.member_id, amount: split.quantity ?? 0 }));
    }
    if (row.split_kind === 'shares') {
      view.splitByShares = splits.map(split => ({ memberId: split.member_id, shares: split.quantity ?? 0 }));
    }
    return view;
  }
}
