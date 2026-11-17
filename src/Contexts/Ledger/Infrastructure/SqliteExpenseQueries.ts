import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { BalanceView, ExpenseView, ShareSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { LEDGER_SCHEMA } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';

type ExpenseRow = { id: string; group_id: string; description: string; amount: number; date: string; paid_by: string };
type ShareRow = { member_id: string; amount: number };
type BalanceRow = { member_id: string; balance: number };

/** The read side of the expenses over SQLite: reads of the file, taken alone, outside any transaction (docs/adr/0004). */
export class SqliteExpenseQueries implements IExpenseQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(LEDGER_SCHEMA));
  }

  async findExpense(expenseId: string): Promise<ExpenseView | undefined> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const row = connection
        .prepare('SELECT id, group_id, description, amount, date, paid_by FROM expenses WHERE id = ?')
        .get(expenseId) as ExpenseRow | undefined;
      if (!row) return undefined;
      const shares = connection
        .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
        .all(expenseId) as ShareRow[];
      return {
        id: String(row.id),
        groupId: String(row.group_id),
        description: String(row.description),
        amount: Number(row.amount),
        date: String(row.date),
        paidBy: String(row.paid_by),
        shares: shares.map((share): ShareSnapshot => ({
          memberId: String(share.member_id),
          amount: Number(share.amount),
        })),
      };
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
}
