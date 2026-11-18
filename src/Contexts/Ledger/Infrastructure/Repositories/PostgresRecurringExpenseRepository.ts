import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IRecurringExpenseSnapshot } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * The tables of recurring expenses (request 23): one row per recurring expense, and one per member of its split, in the order the
 * split was given, with the amount or the shares it was given with. `set_up_seq` is the order they were set up in. A recurring
 * expense records `other` expenses unless its category says otherwise (request 24). Declared with the database, which makes
 * them when it opens (ADR 20).
 */
export function defineRecurringExpensesTables(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      paid_by TEXT NOT NULL,
      currency TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      starts_on TEXT NOT NULL,
      next_on TEXT NOT NULL,
      split_kind TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      version INTEGER NOT NULL,
      set_up_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recurring_splits (
      recurring_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      quantity INTEGER,
      PRIMARY KEY (recurring_id, position)
    );
    CREATE INDEX IF NOT EXISTS recurring_expenses_by_next ON recurring_expenses (next_on);
    CREATE INDEX IF NOT EXISTS recurring_expenses_by_group ON recurring_expenses (group_id);
  `);
}

interface RecurringRow {
  id: string;
  group_id: string;
  paid_by: string;
  currency: string;
  description: string;
  amount: number;
  starts_on: string;
  next_on: string;
  split_kind: 'equal' | 'exact' | 'shares';
  category: Category;
  version: number;
}

interface SplitRow {
  member_id: string;
  quantity: number | null;
}

/** The recurring expenses as aggregates, over the application's PostgreSQL database, inside the transaction of the command or the job. */
export class PostgresRecurringExpenseRepository implements IRecurringExpenseRepository {
  constructor(private database: PostgresDatabase) {
    defineRecurringExpensesTables(database);
  }

  async findById(id: string): Promise<RecurringExpense | null> {
    const row = await this.database.get<RecurringRow>('SELECT * FROM recurring_expenses WHERE id = ?', [id]);
    return row ? this.rebuild(row) : null;
  }

  async dueBy(at: Date): Promise<RecurringExpense[]> {
    const day = at.toISOString().slice(0, 10);
    const rows = await this.database.all<RecurringRow>(
      'SELECT * FROM recurring_expenses WHERE next_on <= ? ORDER BY set_up_seq',
      [day],
    );
    const due: RecurringExpense[] = [];
    for (const row of rows) due.push(await this.rebuild(row));
    return due;
  }

  /** A new recurring expense is inserted at version 1; one read at a version is moved on only where the row is still at it. */
  async save(recurring: RecurringExpense): Promise<IResult> {
    const snapshot = recurring.toSnapshot();
    return snapshot.version === 0 ? this.insert(snapshot) : this.advance(snapshot);
  }

  /** Moved to the group it names, at the version it was read at, which is kept: a move is no change of the recurring expense's day (request 31). */
  async move(recurring: RecurringExpense): Promise<IResult> {
    const { _id: id, groupId, version } = recurring.toSnapshot();
    const moved = await this.database.run('UPDATE recurring_expenses SET group_id = ? WHERE id = ? AND version = ?', [
      groupId,
      id,
      version,
    ]);
    if (moved.changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The recurring expense changed since it was read', { id }),
      );
    }
    return Result.ok();
  }

  /** Removed at the version it was read at; its split goes with it. */
  async remove(recurring: RecurringExpense): Promise<IResult> {
    const { _id: id, version } = recurring.toSnapshot();
    const deleted = await this.database.run('DELETE FROM recurring_expenses WHERE id = ? AND version = ?', [
      id,
      version,
    ]);
    if (deleted.changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The recurring expense changed since it was read', { id }),
      );
    }
    await this.database.run('DELETE FROM recurring_splits WHERE recurring_id = ?', [id]);
    return Result.ok();
  }

  private async insert(snapshot: IRecurringExpenseSnapshot): Promise<IResult> {
    const stored = await this.database.get('SELECT 1 FROM recurring_expenses WHERE id = ?', [snapshot._id]);
    if (stored) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The recurring expense is already stored', { id: snapshot._id }),
      );
    }
    await this.database.run(
      'INSERT INTO recurring_expenses (id, group_id, paid_by, currency, description, amount, starts_on, next_on, split_kind, category, version, set_up_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(set_up_seq), 0) + 1 FROM recurring_expenses))',
      [
        snapshot._id,
        snapshot.groupId,
        snapshot.paidBy,
        snapshot.currency,
        snapshot.description,
        snapshot.amount,
        snapshot.startsOn,
        snapshot.next,
        snapshot.split.kind,
        snapshot.category,
        snapshot.version + 1,
      ],
    );
    const rows = splitRowsOf(snapshot.split);
    for (const [position, [memberId, quantity]] of rows.entries()) {
      await this.database.run(
        'INSERT INTO recurring_splits (recurring_id, position, member_id, quantity) VALUES (?, ?, ?, ?)',
        [snapshot._id, position, memberId, quantity],
      );
    }
    return Result.ok();
  }

  /** Only the day of the next expense moves: the rest of a recurring expense is set once. */
  private async advance(snapshot: IRecurringExpenseSnapshot): Promise<IResult> {
    const updated = await this.database.run(
      'UPDATE recurring_expenses SET next_on = ?, version = ? WHERE id = ? AND version = ?',
      [snapshot.next, snapshot.version + 1, snapshot._id, snapshot.version],
    );
    if (updated.changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The recurring expense changed since it was read', {
          id: snapshot._id,
        }),
      );
    }
    return Result.ok();
  }

  private async rebuild(row: RecurringRow): Promise<RecurringExpense> {
    const rows = await this.database.all<SplitRow>(
      'SELECT member_id, quantity FROM recurring_splits WHERE recurring_id = ? ORDER BY position',
      [row.id],
    );
    return RecurringExpense.fromSnapshot({
      _id: row.id,
      groupId: row.group_id,
      paidBy: row.paid_by,
      currency: row.currency,
      description: row.description,
      amount: row.amount,
      startsOn: row.starts_on,
      next: row.next_on,
      split: splitOf(row.split_kind, rows),
      category: row.category,
      version: row.version,
    });
  }
}

/** The member and the quantity of each entry of a split, in the order it was given: the amount, the shares, or none for an equal split. */
function splitRowsOf(split: SplitRequest): [string, number | null][] {
  switch (split.kind) {
    case 'equal':
      return split.memberIds.map(memberId => [memberId, null]);
    case 'exact':
      return split.amounts.map(share => [share.memberId, share.amount]);
    case 'shares':
      return split.shares.map(share => [share.memberId, share.shares]);
  }
}

function splitOf(kind: RecurringRow['split_kind'], rows: SplitRow[]): SplitRequest {
  switch (kind) {
    case 'equal':
      return { kind, memberIds: rows.map(row => row.member_id) };
    case 'exact':
      return { kind, amounts: rows.map(row => ({ memberId: row.member_id, amount: row.quantity ?? 0 })) };
    case 'shares':
      return { kind, shares: rows.map(row => ({ memberId: row.member_id, shares: row.quantity ?? 0 })) };
  }
}
