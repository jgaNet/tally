import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { RECURRING_STATEMENTS } from '@Contexts/Ledger/Infrastructure/recurring.schema';

interface RecurringRow {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  starts_on: string;
  next: string;
  split_kind: SplitKind;
  set_up_at: string;
  version: number;
}

/** The recurring expenses' repository over the PostgreSQL database; used inside the job's or the command's transaction, which holds the connection, but for `dueBy`. */
export class PostgresRecurringExpenseRepository implements IRecurringExpenseRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(RECURRING_STATEMENTS);
  }

  async findById(id: Id): Promise<RecurringExpense | null> {
    const { connection } = this.database;
    const row = await connection.row<RecurringRow>('SELECT * FROM ledger_recurring_expenses WHERE id = ?', id.value);
    if (!row) return null;
    const category = await connection.row<{ category: Category }>(
      'SELECT category FROM ledger_recurring_categories WHERE recurring_id = ?',
      id.value,
    );
    const members = await connection.rows<{ member_id: string; given: number | null }>(
      'SELECT member_id, given FROM ledger_recurring_members WHERE recurring_id = ? ORDER BY position',
      id.value,
    );
    return RecurringExpense.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      paidBy: row.paid_by,
      description: row.description,
      amount: row.amount,
      startsOn: row.starts_on,
      next: row.next,
      splitKind: row.split_kind,
      members: members.map(member => ({ memberId: member.member_id, given: member.given })),
      category: category?.category ?? 'other',
      setUpAt: row.set_up_at,
      version: row.version,
    });
  }

  /**
   * The job asks it before its transactions, outside any (ADR 16): it takes its own turn on the connection, which no
   * transaction holds then. Each recurring expense it answers is then read again inside the transaction that decides it.
   */
  async dueBy(day: string): Promise<string[]> {
    const rows = await this.database.exclusive(connection =>
      connection.rows<{ id: string }>('SELECT id FROM ledger_recurring_expenses WHERE next <= ? ORDER BY rowid', day),
    );
    return rows.map(row => row.id);
  }

  async save(recurring: RecurringExpense): Promise<IResult> {
    const { id, groupId, paidBy, description, amount, startsOn, next, splitKind, members, category, setUpAt, version } =
      recurring.toSnapshot();
    const { connection } = this.database;
    const conflict = () =>
      Result.fail(
        new ConcurrencyConflictException('Ledger', 'The recurring expense changed since it was read', { id }),
      );

    if (recurring.isRemoved) {
      const { changes } = await connection.run(
        'DELETE FROM ledger_recurring_expenses WHERE id = ? AND version = ?',
        id,
        version,
      );
      if (changes === 0) return conflict();
      await connection.run('DELETE FROM ledger_recurring_members WHERE recurring_id = ?', id);
      await connection.run('DELETE FROM ledger_recurring_categories WHERE recurring_id = ?', id);
      return Result.ok();
    }

    if (version === 0) {
      await connection.run(
        `INSERT INTO ledger_recurring_expenses
           (id, group_id, paid_by, description, amount, starts_on, next, split_kind, set_up_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        id,
        groupId,
        paidBy,
        description,
        amount,
        startsOn,
        next,
        splitKind,
        setUpAt,
      );
    } else {
      const { changes } = await connection.run(
        'UPDATE ledger_recurring_expenses SET next = ?, version = version + 1 WHERE id = ? AND version = ?',
        next,
        id,
        version,
      );
      if (changes === 0) return conflict();
    }
    await connection.run(
      `INSERT INTO ledger_recurring_categories (recurring_id, category) VALUES (?, ?)
       ON CONFLICT (recurring_id) DO UPDATE SET category = excluded.category`,
      id,
      category,
    );
    await connection.run('DELETE FROM ledger_recurring_members WHERE recurring_id = ?', id);
    for (const [position, member] of members.entries()) {
      await connection.run(
        'INSERT INTO ledger_recurring_members (recurring_id, position, member_id, given) VALUES (?, ?, ?, ?)',
        id,
        position,
        member.memberId,
        member.given,
      );
    }
    return Result.ok();
  }
}
