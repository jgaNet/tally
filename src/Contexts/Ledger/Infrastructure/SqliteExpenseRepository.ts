import { IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/**
 * The ledger's tables: an expense is a row, and its shares are rows of their own, keyed by the expense and the position
 * in the split, so the order the split was given is kept.
 */
export const LEDGER_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL, paid_by TEXT NOT NULL, version INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS expense_shares (expense_id TEXT NOT NULL REFERENCES expenses (id), position INTEGER NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (expense_id, position))',
].join(';\n');

/** The expenses' store over SQLite (docs/adr/0004). Its methods run inside a transaction: the use case's. */
export class SqliteExpenseRepository implements IExpenseRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(LEDGER_SCHEMA));
  }

  async save(expense: Expense): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = expense.toSnapshot();
    if (snapshot.version !== 0) {
      // An expense is recorded once and never changed: a save of one already stored is a programming error.
      throw new Error(`The expense ${snapshot.id} is stored already: an expense is recorded once`);
    }
    const connection = this.database.connection;
    connection
      .prepare(
        'INSERT INTO expenses (id, group_id, description, amount, date, paid_by, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        snapshot.id,
        snapshot.groupId,
        snapshot.description,
        snapshot.amount,
        snapshot.date,
        snapshot.paidBy,
        snapshot.version + 1,
      );
    const insertShare = connection.prepare(
      'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
    );
    snapshot.shares.forEach((share, position) => {
      insertShare.run(snapshot.id, position, share.memberId, share.amount);
    });
    return Result.ok(undefined);
  }
}
