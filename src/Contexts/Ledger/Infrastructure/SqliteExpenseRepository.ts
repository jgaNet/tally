import { Id, IResult, Result } from '@Architecture/Domain';
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
}

interface ShareRow {
  member_id: string;
  amount: number;
}

export class SqliteExpenseRepository implements IExpenseRepository {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async findById(id: Id): Promise<Expense | null> {
    const row = this.database.get<Row>(
      'SELECT id, group_id, description, amount, spent_on, paid_by FROM expenses WHERE id = ?',
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
    });
  }

  async save(expense: Expense): Promise<IResult> {
    const { id, groupId, description, amount, date, paidBy, shares } = expense.toSnapshot();
    this.database.run(
      'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      groupId,
      description,
      amount,
      date,
      paidBy,
    );
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
}
