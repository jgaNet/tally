import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import {
  ExpenseReadModel,
  OriginalReadModel,
  ShareReadModel,
} from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

/** What the screens read of the expenses, from the SQLite file, outside any transaction. */
export class SqliteExpenseQueries implements IExpenseQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  findById(id: string): Promise<ExpenseReadModel | null> {
    return this.database.exclusive(connection => {
      const row = connection
        .prepare(
          `SELECT e.id, e.group_id AS groupId, e.description, e.amount, e.date, e.paid_by AS paidBy,
                  k.split_kind AS splitKind, COALESCE(c.category, 'other') AS category, e.version
             FROM ledger_expenses e JOIN ledger_expense_splits k ON k.expense_id = e.id
             LEFT JOIN ledger_expense_categories c ON c.expense_id = e.id
            WHERE e.id = ?`,
        )
        .get(id) as Omit<ExpenseReadModel, 'shares'> | undefined;
      if (!row) return null;
      const shares = connection
        .prepare(
          'SELECT member_id AS memberId, amount FROM ledger_expense_shares WHERE expense_id = ? ORDER BY position',
        )
        .all(id) as unknown as ShareReadModel[];
      const original = connection
        .prepare('SELECT currency, amount, rate FROM ledger_expense_originals WHERE expense_id = ?')
        .get(id) as OriginalReadModel | undefined;
      return original ? { ...row, shares, original } : { ...row, shares };
    });
  }

  listByGroup(groupId: string): Promise<ExpenseReadModel[]> {
    return this.database.exclusive(connection => {
      // `rowid` breaks a tie of the same instant: the expenses were inserted in the order they were recorded.
      const rows = connection
        .prepare(
          `SELECT e.id, e.group_id AS groupId, e.description, e.amount, e.date, e.paid_by AS paidBy,
                  k.split_kind AS splitKind, COALESCE(c.category, 'other') AS category, e.version
             FROM ledger_expenses e JOIN ledger_expense_splits k ON k.expense_id = e.id
             LEFT JOIN ledger_expense_categories c ON c.expense_id = e.id
            WHERE e.group_id = ?
            ORDER BY e.date DESC, e.recorded_at DESC, e.rowid DESC`,
        )
        .all(groupId) as unknown as Omit<ExpenseReadModel, 'shares'>[];
      const shareRows = connection
        .prepare(
          `SELECT s.expense_id AS expenseId, s.member_id AS memberId, s.amount
             FROM ledger_expense_shares s JOIN ledger_expenses e ON e.id = s.expense_id
            WHERE e.group_id = ?
            ORDER BY s.expense_id, s.position`,
        )
        .all(groupId) as unknown as (ShareReadModel & { expenseId: string })[];
      const sharesOf = new Map<string, ShareReadModel[]>();
      for (const { expenseId, memberId, amount } of shareRows) {
        const shares = sharesOf.get(expenseId) ?? [];
        shares.push({ memberId, amount });
        sharesOf.set(expenseId, shares);
      }
      const originalsOf = new Map<string, OriginalReadModel>(
        (
          connection
            .prepare(
              `SELECT o.expense_id AS expenseId, o.currency, o.amount, o.rate
                 FROM ledger_expense_originals o JOIN ledger_expenses e ON e.id = o.expense_id
                WHERE e.group_id = ?`,
            )
            .all(groupId) as unknown as (OriginalReadModel & { expenseId: string })[]
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
