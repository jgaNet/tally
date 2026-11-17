import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  BalanceView,
  ExpenseView,
  ShareSnapshot,
  SplitKind,
  StatementEntryView,
} from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { prepareLedgerSchema } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';

type ExpenseRow = {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  split_kind: string;
  version: number;
};
type ShareRow = { member_id: string; amount: number };
type GroupShareRow = ShareRow & { expense_id: string };
type BalanceRow = { member_id: string; balance: number };
type StatementRow = {
  expense_id: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
};

/** The read side of the expenses over SQLite: reads of the file, taken alone, outside any transaction (docs/adr/0004). */
export class SqliteExpenseQueries implements IExpenseQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareLedgerSchema);
  }

  async findExpense(expenseId: string): Promise<ExpenseView | undefined> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const row = connection
        .prepare(
          'SELECT id, group_id, description, amount, date, paid_by, split_kind, version FROM expenses WHERE id = ?',
        )
        .get(expenseId) as ExpenseRow | undefined;
      if (!row) return undefined;
      const shares = connection
        .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
        .all(expenseId) as ShareRow[];
      return expenseView(row, shares);
    });
  }

  async balancesOf(groupId: string): Promise<BalanceView[]> {
    // One statement, so one snapshot: what a member paid, less their shares, over the group's expenses (docs/adr/0005).
    return this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(
          `SELECT member_id, SUM(amount) AS balance FROM (
             SELECT paid_by AS member_id, amount FROM expenses WHERE group_id = ?
             UNION ALL
             SELECT s.member_id, -s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?
           ) GROUP BY member_id`,
        )
        .all(groupId, groupId) as BalanceRow[];
      return rows.map((row): BalanceView => ({ memberId: String(row.member_id), balance: Number(row.balance) }));
    });
  }

  async expensesOf(groupId: string): Promise<ExpenseView[]> {
    // The rowid is the order of recording: an edit updates the row in place, so it keeps the rowid it was inserted with (docs/adr/0008).
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const rows = connection
        .prepare(
          'SELECT id, group_id, description, amount, date, paid_by, split_kind, version FROM expenses WHERE group_id = ? ORDER BY date DESC, rowid DESC',
        )
        .all(groupId) as ExpenseRow[];
      const shares = connection
        .prepare(
          'SELECT s.expense_id, s.member_id, s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ? ORDER BY s.expense_id, s.position',
        )
        .all(groupId) as GroupShareRow[];
      const sharesByExpense = new Map<string, ShareRow[]>();
      for (const share of shares) {
        const list = sharesByExpense.get(share.expense_id) ?? [];
        list.push(share);
        sharesByExpense.set(share.expense_id, list);
      }
      return rows.map(row => expenseView(row, sharesByExpense.get(row.id) ?? []));
    });
  }

  async statementOf(groupId: string, memberId: string): Promise<StatementEntryView[]> {
    // One statement, so one snapshot: the member's entries and their running balance, in a bank statement's order (docs/adr/0008).
    // The running balance is a window sum over what the member paid less their share; the rowid breaks a tie in the date.
    return this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(
          `SELECT expense_id, date, description, paid, share,
               SUM(paid - share) OVER (ORDER BY date, rid) AS balance
             FROM (
               SELECT e.rowid AS rid, e.id AS expense_id, e.date AS date, e.description AS description,
                 CASE WHEN e.paid_by = ? THEN e.amount ELSE 0 END AS paid,
                 COALESCE((SELECT s.amount FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = ?), 0) AS share
               FROM expenses e
               WHERE e.group_id = ?
                 AND (e.paid_by = ? OR EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = ?))
             )
             ORDER BY date, rid`,
        )
        .all(memberId, memberId, groupId, memberId, memberId) as StatementRow[];
      return rows.map((row): StatementEntryView => ({
        expenseId: String(row.expense_id),
        date: String(row.date),
        description: String(row.description),
        paid: Number(row.paid),
        share: Number(row.share),
        balance: Number(row.balance),
      }));
    });
  }
}

/** An expense's read model from its row and its shares, in the order of the split. */
function expenseView(row: ExpenseRow, shares: ShareRow[]): ExpenseView {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    description: String(row.description),
    amount: Number(row.amount),
    date: String(row.date),
    paidBy: String(row.paid_by),
    splitKind: String(row.split_kind) as SplitKind,
    version: Number(row.version),
    shares: shares.map((share): ShareSnapshot => ({ memberId: String(share.member_id), amount: Number(share.amount) })),
  };
}
