import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  split_kind: SplitKind;
  recorded_at: string;
  version: number;
}

/** The expenses' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresExpenseRepository implements IExpenseRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async findById(id: Id): Promise<Expense | null> {
    const { connection } = this.database;
    const row = await connection.row<ExpenseRow>(
      `SELECT e.id, e.group_id, e.description, e.amount, e.date, e.paid_by, k.split_kind, e.recorded_at, e.version
         FROM ledger_expenses e JOIN ledger_expense_splits k ON k.expense_id = e.id
        WHERE e.id = ?`,
      id.value,
    );
    if (!row) return null;
    const category = await connection.row<{ category: Category }>(
      'SELECT category FROM ledger_expense_categories WHERE expense_id = ?',
      id.value,
    );
    const shares = await connection.rows<{ member_id: string; amount: number }>(
      'SELECT member_id, amount FROM ledger_expense_shares WHERE expense_id = ? ORDER BY position',
      id.value,
    );
    const original = await connection.row<{ currency: string; amount: number; rate: string }>(
      'SELECT currency, amount, rate FROM ledger_expense_originals WHERE expense_id = ?',
      id.value,
    );
    return Expense.fromSnapshot({
      original: original ? { currency: original.currency, amount: original.amount, rate: original.rate } : null,
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.date,
      paidBy: row.paid_by,
      splitKind: row.split_kind,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
      recordedAt: row.recorded_at,
      category: category?.category ?? 'other',
      version: row.version,
    });
  }

  async idsInGroup(groupId: Id): Promise<Id[]> {
    const rows = await this.database.connection.rows<{ id: string }>(
      'SELECT id FROM ledger_expenses WHERE group_id = ? ORDER BY rowid',
      groupId.value,
    );
    return rows.map(row => new Id(row.id));
  }

  async save(expense: Expense): Promise<IResult> {
    const { id, groupId, description, amount, original, date, paidBy, splitKind, shares, recordedAt, version } =
      expense.toSnapshot();
    const { connection } = this.database;
    const conflict = () =>
      Result.fail(new ConcurrencyConflictException('Ledger', 'The expense changed since it was read', { id }));

    if (expense.isDeleted) {
      const { changes } = await connection.run('DELETE FROM ledger_expenses WHERE id = ? AND version = ?', id, version);
      if (changes === 0) return conflict();
      await connection.run('DELETE FROM ledger_expense_shares WHERE expense_id = ?', id);
      await connection.run('DELETE FROM ledger_expense_splits WHERE expense_id = ?', id);
      await connection.run('DELETE FROM ledger_expense_categories WHERE expense_id = ?', id);
      await connection.run('DELETE FROM ledger_expense_originals WHERE expense_id = ?', id);
      await connection.run('DELETE FROM ledger_balance_entries WHERE expense_id = ?', id);
      return Result.ok();
    }

    // A move changes the expense's group and nothing else, its version included (request 31): the version is its edits'.
    if (expense.isMoved) {
      const { changes } = await connection.run(
        'UPDATE ledger_expenses SET group_id = ? WHERE id = ? AND version = ?',
        groupId,
        id,
        version,
      );
      if (changes === 0) return conflict();
      await connection.run('UPDATE ledger_balance_entries SET group_id = ? WHERE expense_id = ?', groupId, id);
      return Result.ok();
    }

    if (version === 0) {
      await connection.run(
        `INSERT INTO ledger_expenses (id, group_id, description, amount, date, paid_by, recorded_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        id,
        groupId,
        description,
        amount,
        date,
        paidBy,
        recordedAt,
      );
    } else {
      const { changes } = await connection.run(
        `UPDATE ledger_expenses SET description = ?, amount = ?, date = ?, version = version + 1
          WHERE id = ? AND version = ?`,
        description,
        amount,
        date,
        id,
        version,
      );
      if (changes === 0) return conflict();
    }
    await connection.run(
      `INSERT INTO ledger_expense_splits (expense_id, split_kind) VALUES (?, ?)
       ON CONFLICT (expense_id) DO UPDATE SET split_kind = excluded.split_kind`,
      id,
      splitKind,
    );
    await connection.run(
      `INSERT INTO ledger_expense_categories (expense_id, category) VALUES (?, ?)
       ON CONFLICT (expense_id) DO UPDATE SET category = excluded.category`,
      id,
      expense.toSnapshot().category,
    );
    if (original) {
      await connection.run(
        `INSERT INTO ledger_expense_originals (expense_id, currency, amount, rate) VALUES (?, ?, ?, ?)
         ON CONFLICT (expense_id) DO UPDATE SET currency = excluded.currency, amount = excluded.amount, rate = excluded.rate`,
        id,
        original.currency,
        original.amount,
        original.rate,
      );
    } else {
      await connection.run('DELETE FROM ledger_expense_originals WHERE expense_id = ?', id);
    }
    await connection.run('DELETE FROM ledger_expense_shares WHERE expense_id = ?', id);
    for (const [position, { memberId, amount: share }] of shares.entries()) {
      await connection.run(
        'INSERT INTO ledger_expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
        id,
        position,
        memberId,
        share,
      );
    }
    await connection.run('DELETE FROM ledger_balance_entries WHERE expense_id = ?', id);
    await this.recordBalanceEntries(id, groupId, paidBy, amount, shares);
    return Result.ok();
  }

  /**
   * The expense's effect on each member's balance, written with the expense as it is saved (the balances' read model):
   * the payer's net is what they paid minus their own share, each other member's is minus their share. They add up to 0.
   * An edit replaces them in the same transaction; a deletion removes them.
   */
  private async recordBalanceEntries(
    id: string,
    groupId: string,
    paidBy: string,
    amount: number,
    shares: readonly { memberId: string; amount: number }[],
  ): Promise<void> {
    const nets = new Map<string, number>([[paidBy, amount]]);
    for (const { memberId, amount: share } of shares) nets.set(memberId, (nets.get(memberId) ?? 0) - share);
    for (const [memberId, net] of nets) {
      await this.database.connection.run(
        'INSERT INTO ledger_balance_entries (expense_id, group_id, member_id, amount) VALUES (?, ?, ?, ?)',
        id,
        groupId,
        memberId,
        net,
      );
    }
  }
}
