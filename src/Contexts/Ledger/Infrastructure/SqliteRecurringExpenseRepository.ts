import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
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

/** The recurring expenses' repository over the SQLite file; used inside the job's or the command's transaction, which holds the connection. */
export class SqliteRecurringExpenseRepository implements IRecurringExpenseRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(RECURRING_STATEMENTS);
  }

  async findById(id: Id): Promise<RecurringExpense | null> {
    const { connection } = this.database;
    const row = connection.prepare('SELECT * FROM ledger_recurring_expenses WHERE id = ?').get(id.value) as
      RecurringRow | undefined;
    if (!row) return null;
    const category = connection
      .prepare('SELECT category FROM ledger_recurring_categories WHERE recurring_id = ?')
      .get(id.value) as { category: Category } | undefined;
    const members = connection
      .prepare('SELECT member_id, given FROM ledger_recurring_members WHERE recurring_id = ? ORDER BY position')
      .all(id.value) as { member_id: string; given: number | null }[];
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

  async dueBy(day: string): Promise<string[]> {
    const rows = this.database.connection
      .prepare('SELECT id FROM ledger_recurring_expenses WHERE next <= ? ORDER BY rowid')
      .all(day) as { id: string }[];
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
      const { changes } = connection
        .prepare('DELETE FROM ledger_recurring_expenses WHERE id = ? AND version = ?')
        .run(id, version);
      if (changes === 0) return conflict();
      connection.prepare('DELETE FROM ledger_recurring_members WHERE recurring_id = ?').run(id);
      connection.prepare('DELETE FROM ledger_recurring_categories WHERE recurring_id = ?').run(id);
      return Result.ok();
    }

    if (version === 0) {
      connection
        .prepare(
          `INSERT INTO ledger_recurring_expenses
             (id, group_id, paid_by, description, amount, starts_on, next, split_kind, set_up_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(id, groupId, paidBy, description, amount, startsOn, next, splitKind, setUpAt);
    } else {
      const { changes } = connection
        .prepare('UPDATE ledger_recurring_expenses SET next = ?, version = version + 1 WHERE id = ? AND version = ?')
        .run(next, id, version);
      if (changes === 0) return conflict();
    }
    connection
      .prepare('INSERT OR REPLACE INTO ledger_recurring_categories (recurring_id, category) VALUES (?, ?)')
      .run(id, category);
    connection.prepare('DELETE FROM ledger_recurring_members WHERE recurring_id = ?').run(id);
    members.forEach((member, position) =>
      connection
        .prepare('INSERT INTO ledger_recurring_members (recurring_id, position, member_id, given) VALUES (?, ?, ?, ?)')
        .run(id, position, member.memberId, member.given),
    );
    return Result.ok();
  }
}
