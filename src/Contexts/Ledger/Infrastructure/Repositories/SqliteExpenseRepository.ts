import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';

/** The tables of expenses: one row per expense, and one per share, in the order of the split. */
export function createExpensesTables(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      spent_on TEXT NOT NULL,
      paid_by TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expense_shares (
      expense_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      PRIMARY KEY (expense_id, position)
    );
  `);
}

interface ExpenseRow {
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

/** The expenses as aggregates, over the application's SQLite file, inside the transaction of the command. */
export class SqliteExpenseRepository implements IExpenseRepository {
  constructor(private database: SqliteDatabase) {
    createExpensesTables(database);
  }

  async findById(id: string): Promise<Expense | null> {
    const connection = this.database.connection;
    const row = connection.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as ExpenseRow | undefined;
    if (!row) return null;

    const shares = connection
      .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
      .all(id) as unknown as ShareRow[];
    return Expense.fromSnapshot({
      _id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.spent_on,
      paidBy: row.paid_by,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
      version: row.version,
    });
  }

  /** An expense is stored once, at version 1; one already stored is a conflict, since nothing changes it. */
  async save(expense: Expense): Promise<IResult> {
    const snapshot: IExpenseSnapshot = expense.toSnapshot();
    const connection = this.database.connection;

    const stored = connection.prepare('SELECT version FROM expenses WHERE id = ?').get(snapshot._id);
    if (stored) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The expense is already stored', { id: snapshot._id }),
      );
    }
    connection
      .prepare(
        'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        snapshot._id,
        snapshot.groupId,
        snapshot.description,
        snapshot.amount,
        snapshot.date,
        snapshot.paidBy,
        snapshot.version + 1,
      );
    snapshot.shares.forEach((share, position) =>
      connection
        .prepare('INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)')
        .run(snapshot._id, position, share.memberId, share.amount),
    );
    return Result.ok();
  }
}
