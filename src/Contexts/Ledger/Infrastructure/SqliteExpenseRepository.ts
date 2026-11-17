import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface Row {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  version: number;
}

interface ShareRow {
  member_id: string;
  amount: number;
}

/**
 * The expenses, in the application's file. It runs inside the command's transaction, which holds the file, so it takes no
 * lock of its own. A save or a delete that finds the expense at another version than it was read at is a conflict; the
 * command's transaction is then rolled back with it, so the expense, its shares and its balances are stored together or not.
 */
export class SqliteExpenseRepository implements IExpenseRepository {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async findById(id: Id): Promise<Expense | null> {
    const row = this.database.get<Row>(
      'SELECT id, group_id, description, amount, spent_on, paid_by, version FROM expenses WHERE id = ?',
      id.value,
    );
    if (!row) return null;
    const shares = this.database.all<ShareRow>(
      'SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position',
      id.value,
    );
    return Expense.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.spent_on,
      paidBy: row.paid_by,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
      version: row.version,
    });
  }

  async save(expense: Expense): Promise<IResult> {
    const { id, groupId, description, amount, date, paidBy, shares, version } = expense.toSnapshot();
    if (version === 0) {
      this.database.run(
        'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        groupId,
        description,
        amount,
        date,
        paidBy,
        1,
      );
    } else {
      const changed = this.database.run(
        `UPDATE expenses SET description = ?, amount = ?, spent_on = ?, paid_by = ?, version = ?
         WHERE id = ? AND version = ?`,
        description,
        amount,
        date,
        paidBy,
        version + 1,
        id,
        version,
      );
      if (!changed) return conflict(id);
      this.database.run('DELETE FROM expense_shares WHERE expense_id = ?', id);
    }
    shares.forEach((share, position) =>
      this.database.run(
        'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
        id,
        position,
        share.memberId,
        share.amount,
      ),
    );
    return Result.ok();
  }

  async delete(expense: Expense): Promise<IResult> {
    const { id, version } = expense.toSnapshot();
    const removed = this.database.run('DELETE FROM expenses WHERE id = ? AND version = ?', id, version);
    if (!removed) return conflict(id);
    this.database.run('DELETE FROM expense_shares WHERE expense_id = ?', id);
    return Result.ok();
  }
}

const conflict = (id: string): IResult =>
  Result.fail(new ConcurrencyConflictException('Ledger', 'The expense has changed', { id }));
