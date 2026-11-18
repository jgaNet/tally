import { Connection, PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import {
  ExpenseReadModel,
  OriginalReadModel,
  ShareReadModel,
} from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/**
 * What the screens read of the expenses, from the PostgreSQL database, outside any transaction. A command that reads the read model
 * inside its own transaction takes `inCommand`: the transaction holds the connection, so it reads that connection directly.
 */
export class PostgresExpenseQueries implements IExpenseQueries {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly inCommand = false,
  ) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  private run<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    return this.inCommand ? fn(this.database.connection) : this.database.exclusive(fn);
  }

  findById(id: string): Promise<ExpenseReadModel | null> {
    return this.run(async connection => {
      const row = await connection.row<Omit<ExpenseReadModel, 'shares'>>(
        `SELECT e.id, e.group_id AS "groupId", e.description, e.amount, e.date, e.paid_by AS "paidBy",
                k.split_kind AS "splitKind", COALESCE(c.category, 'other') AS category, e.version
           FROM ledger_expenses e JOIN ledger_expense_splits k ON k.expense_id = e.id
           LEFT JOIN ledger_expense_categories c ON c.expense_id = e.id
          WHERE e.id = ?`,
        id,
      );
      if (!row) return null;
      const shares = await connection.rows<ShareReadModel>(
        'SELECT member_id AS "memberId", amount FROM ledger_expense_shares WHERE expense_id = ? ORDER BY position',
        id,
      );
      const original = await connection.row<OriginalReadModel>(
        'SELECT currency, amount, rate FROM ledger_expense_originals WHERE expense_id = ?',
        id,
      );
      return original ? { ...row, shares, original } : { ...row, shares };
    });
  }

  listByGroup(groupId: string): Promise<ExpenseReadModel[]> {
    return this.run(async connection => {
      // `rowid` breaks a tie of the same instant: the expenses were inserted in the order they were recorded.
      const rows = await connection.rows<Omit<ExpenseReadModel, 'shares'>>(
        `SELECT e.id, e.group_id AS "groupId", e.description, e.amount, e.date, e.paid_by AS "paidBy",
                k.split_kind AS "splitKind", COALESCE(c.category, 'other') AS category, e.version
           FROM ledger_expenses e JOIN ledger_expense_splits k ON k.expense_id = e.id
           LEFT JOIN ledger_expense_categories c ON c.expense_id = e.id
          WHERE e.group_id = ?
          ORDER BY e.date DESC, e.recorded_at DESC, e.rowid DESC`,
        groupId,
      );
      const shareRows = await connection.rows<ShareReadModel & { expenseId: string }>(
        `SELECT s.expense_id AS "expenseId", s.member_id AS "memberId", s.amount
           FROM ledger_expense_shares s JOIN ledger_expenses e ON e.id = s.expense_id
          WHERE e.group_id = ?
          ORDER BY s.expense_id, s.position`,
        groupId,
      );
      const sharesOf = new Map<string, ShareReadModel[]>();
      for (const { expenseId, memberId, amount } of shareRows) {
        const shares = sharesOf.get(expenseId) ?? [];
        shares.push({ memberId, amount });
        sharesOf.set(expenseId, shares);
      }
      const originalsOf = new Map<string, OriginalReadModel>(
        (
          await connection.rows<OriginalReadModel & { expenseId: string }>(
            `SELECT o.expense_id AS "expenseId", o.currency, o.amount, o.rate
               FROM ledger_expense_originals o JOIN ledger_expenses e ON e.id = o.expense_id
              WHERE e.group_id = ?`,
            groupId,
          )
        ).map(({ expenseId, currency, amount, rate }) => [expenseId, { currency, amount, rate }]),
      );
      return rows.map(row => {
        const original = originalsOf.get(row.id);
        const shares = sharesOf.get(row.id) ?? [];
        return original ? { ...row, shares, original } : { ...row, shares };
      });
    });
  }
}
