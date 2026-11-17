import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Application/IExpenseRepository';
import { ExpenseView, IExpenseQueries } from '@Contexts/Ledger/Application/IExpenseQueries';

import { LedgerDatabase } from './LedgerDatabase';

type ExpenseRow = { id: string; group_id: string; description: string; amount: number; date: string; paid_by: string };
type ShareRow = { member_id: string; amount: number };

/**
 * The expenses in SQLite: the repository `RecordExpense` inserts into, and the read side `GetExpense` reads. An expense and
 * its shares are written in one transaction, so an expense never has a share missing.
 */
export class SqliteExpenses implements IExpenseRepository, IExpenseQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async insert(expense: Expense): Promise<void> {
    const { id, groupId, description, amount, date, paidBy, shares } = expense.toSnapshot();
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection
        .prepare(
          'INSERT INTO ledger_expenses (id, group_id, description, amount, date, paid_by) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, groupId, description, amount, date, paidBy);
      const insertShare = connection.prepare(
        'INSERT INTO ledger_expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
      );
      shares.forEach((share, position) => insertShare.run(id, position, share.memberId, share.amount));
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async expenseOf(id: string): Promise<ExpenseView | undefined> {
    const connection = this.database.connection;
    const row = connection
      .prepare('SELECT id, group_id, description, amount, date, paid_by FROM ledger_expenses WHERE id = ?')
      .get(id) as ExpenseRow | undefined;
    if (!row) return undefined;
    const shares = connection
      .prepare('SELECT member_id, amount FROM ledger_expense_shares WHERE expense_id = ? ORDER BY position')
      .all(id) as ShareRow[];
    return {
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.date,
      paidBy: row.paid_by,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
    };
  }
}
