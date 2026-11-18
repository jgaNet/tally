import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SplitInput, SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseRepository';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface Row {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  starts_on: string;
  next_on: string;
  split_kind: SplitKind;
  version: number;
}

interface SplitRow {
  member_id: string;
  amount: number | null;
  shares: number | null;
}

/**
 * The recurring expenses, in the application's file. Like the expenses', it runs inside the transaction that holds the file, so it
 * takes no lock of its own, except for the due days, which the sweep reads outside any transaction. A save or a delete that finds
 * the recurring expense at another version than it was read at is a conflict, and its transaction is rolled back with it.
 */
export class SqliteRecurringExpenseRepository implements IRecurringExpenseRepository {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async findById(id: Id): Promise<RecurringExpense | null> {
    const row = this.database.get<Row>(
      `SELECT id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, version
       FROM recurring_expenses WHERE id = ?`,
      id.value,
    );
    if (!row) return null;
    const splits = this.database.all<SplitRow>(
      'SELECT member_id, amount, shares FROM recurring_expense_splits WHERE recurring_id = ? ORDER BY position',
      id.value,
    );
    return RecurringExpense.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      paidBy: row.paid_by,
      description: row.description,
      amount: row.amount,
      startsOn: row.starts_on,
      next: row.next_on,
      split: splitOf(row.split_kind, splits),
      version: row.version,
    });
  }

  async findDueIds(today: string): Promise<Id[]> {
    const rows = await this.database.exclusive(() =>
      this.database.all<{ id: string }>(
        'SELECT id FROM recurring_expenses WHERE next_on <= ? ORDER BY set_up_seq',
        today,
      ),
    );
    return rows.map(row => new Id(row.id));
  }

  async save(recurring: RecurringExpense): Promise<IResult> {
    const { id, groupId, paidBy, description, amount, startsOn, next, split, version } = recurring.toSnapshot();
    if (version === 0) {
      this.database.run(
        `INSERT INTO recurring_expenses (id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, version,
                                         set_up_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(set_up_seq), 0) + 1 FROM recurring_expenses))`,
        id,
        groupId,
        paidBy,
        description,
        amount,
        startsOn,
        next,
        split.kind,
      );
      splitRows(split).forEach((member, position) =>
        this.database.run(
          'INSERT INTO recurring_expense_splits (recurring_id, position, member_id, amount, shares) VALUES (?, ?, ?, ?, ?)',
          id,
          position,
          member.memberId,
          member.amount,
          member.shares,
        ),
      );
      return Result.ok();
    }
    // Only the next day moves once it is set up: what it is, and how it was split, never changes.
    const changed = this.database.run(
      'UPDATE recurring_expenses SET next_on = ?, version = ? WHERE id = ? AND version = ?',
      next,
      version + 1,
      id,
      version,
    );
    return changed ? Result.ok() : conflict(id);
  }

  async remove(recurring: RecurringExpense): Promise<IResult> {
    const { id, version } = recurring.toSnapshot();
    const removed = this.database.run('DELETE FROM recurring_expenses WHERE id = ? AND version = ?', id, version);
    if (!removed) return conflict(id);
    this.database.run('DELETE FROM recurring_expense_splits WHERE recurring_id = ?', id);
    return Result.ok();
  }
}

/** The split as it was given, one row per member: an equal split keeps its members only, the other two keep their amounts. */
function splitRows(split: SplitInput): { memberId: string; amount: number | null; shares: number | null }[] {
  switch (split.kind) {
    case 'equal':
      return split.members.map(memberId => ({ memberId, amount: null, shares: null }));
    case 'exact':
      return split.amounts.map(share => ({ memberId: share.memberId, amount: share.amount, shares: null }));
    case 'shares':
      return split.shares.map(share => ({ memberId: share.memberId, amount: null, shares: share.shares }));
  }
}

function splitOf(kind: SplitKind, rows: SplitRow[]): SplitInput {
  switch (kind) {
    case 'equal':
      return { kind, members: rows.map(row => row.member_id) };
    case 'exact':
      return { kind, amounts: rows.map(row => ({ memberId: row.member_id, amount: row.amount ?? 0 })) };
    case 'shares':
      return { kind, shares: rows.map(row => ({ memberId: row.member_id, shares: row.shares ?? 0 })) };
  }
}

const conflict = (id: string): IResult =>
  Result.fail(new ConcurrencyConflictException('Ledger', 'The recurring expense has changed', { id }));
