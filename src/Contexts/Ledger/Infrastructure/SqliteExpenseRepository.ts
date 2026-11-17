import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { EXPENSE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/expenses.schema';

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  recorded_at: string;
  version: number;
}

/** The expenses' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqliteExpenseRepository implements IExpenseRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(EXPENSE_STATEMENTS);
  }

  async findById(id: Id): Promise<Expense | null> {
    const { connection } = this.database;
    const row = connection.prepare('SELECT * FROM ledger_expenses WHERE id = ?').get(id.value) as
      ExpenseRow | undefined;
    if (!row) return null;
    const shares = connection
      .prepare('SELECT member_id, amount FROM ledger_expense_shares WHERE expense_id = ? ORDER BY position')
      .all(id.value) as { member_id: string; amount: number }[];
    return Expense.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.date,
      paidBy: row.paid_by,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
      recordedAt: row.recorded_at,
      version: row.version,
    });
  }

  async save(expense: Expense): Promise<IResult> {
    const { id, groupId, description, amount, date, paidBy, shares, recordedAt, version } = expense.toSnapshot();
    const { connection } = this.database;
    if (version === 0) {
      connection
        .prepare(
          `INSERT INTO ledger_expenses (id, group_id, description, amount, date, paid_by, recorded_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(id, groupId, description, amount, date, paidBy, recordedAt);
    } else {
      const { changes } = connection
        .prepare('UPDATE ledger_expenses SET version = version + 1 WHERE id = ? AND version = ?')
        .run(id, version);
      if (changes === 0) {
        return Result.fail(new ConcurrencyConflictException('Ledger', 'The expense changed since it was read', { id }));
      }
    }
    connection.prepare('DELETE FROM ledger_expense_shares WHERE expense_id = ?').run(id);
    shares.forEach(({ memberId, amount: share }, position) =>
      connection
        .prepare('INSERT INTO ledger_expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)')
        .run(id, position, memberId, share),
    );
    if (version === 0) this.recordBalanceEntries(id, groupId, paidBy, amount, shares);
    return Result.ok();
  }

  /**
   * The expense's effect on each member's balance, written with the expense (the balances' read model): the payer's
   * net is what they paid minus their own share, each other member's is minus their share. They add up to 0.
   */
  private recordBalanceEntries(
    id: string,
    groupId: string,
    paidBy: string,
    amount: number,
    shares: readonly { memberId: string; amount: number }[],
  ): void {
    const nets = new Map<string, number>([[paidBy, amount]]);
    for (const { memberId, amount: share } of shares) nets.set(memberId, (nets.get(memberId) ?? 0) - share);
    for (const [memberId, net] of nets) {
      this.database.connection
        .prepare('INSERT INTO ledger_balance_entries (expense_id, group_id, member_id, amount) VALUES (?, ?, ?, ?)')
        .run(id, groupId, memberId, net);
    }
  }
}
