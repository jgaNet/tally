import { ConcurrencyConflictException } from '@Architecture/Domain';
import { RecurringExpense, RecurringExpenseSnapshot } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';
import { IRecurringExpenseRepository } from '@Contexts/Ledger/Application/IRecurringExpenseRepository';
import { IRecurringExpenseQueries, RecurringExpenseView } from '@Contexts/Ledger/Application/IRecurringExpenseQueries';

import { LedgerDatabase } from './LedgerDatabase';

type RecurringRow = {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  starts_on: string;
  next: string;
  split_kind: 'equal' | 'exact' | 'shares';
  category: ExpenseCategory;
  version: number;
};
type ShareRow = { member_id: string; share_value: number };
const RECURRING_COLUMNS = 'id, group_id, paid_by, description, amount, starts_on, next, split_kind, category, version';

/**
 * The recurring expenses in SQLite (request 23): the repository the set-up, stop and sweep use cases load and write, and the read side the
 * reads use. A recurring expense and its split are written in one transaction. A save or a removal is conditional on the version it was
 * read at (CONC-OPTIMISTIC): the check and the write are one transaction on the file, so of two writers from one version the second is
 * refused and keeps nothing of its change.
 */
export class SqliteRecurringExpenses implements IRecurringExpenseRepository, IRecurringExpenseQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async get(id: string): Promise<RecurringExpense | undefined> {
    const row = this.database.connection
      .prepare(`SELECT ${RECURRING_COLUMNS} FROM ledger_recurring_expenses WHERE id = ?`)
      .get(id) as RecurringRow | undefined;
    return row ? RecurringExpense.fromSnapshot(this.#snapshotOf(row)) : undefined;
  }

  async all(): Promise<RecurringExpense[]> {
    const rows = this.database.connection
      .prepare(`SELECT ${RECURRING_COLUMNS} FROM ledger_recurring_expenses ORDER BY rowid`)
      .all() as RecurringRow[];
    return rows.map(row => RecurringExpense.fromSnapshot(this.#snapshotOf(row)));
  }

  async insert(recurring: RecurringExpense): Promise<void> {
    const snapshot = recurring.toSnapshot();
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      connection
        .prepare(
          'INSERT INTO ledger_recurring_expenses (id, group_id, paid_by, description, amount, starts_on, next, split_kind, category, version) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          snapshot.id,
          snapshot.groupId,
          snapshot.paidBy,
          snapshot.description,
          snapshot.amount,
          snapshot.startsOn,
          snapshot.next,
          snapshot.split.kind,
          snapshot.category,
          snapshot.version + 1,
        );
      this.#insertShares(snapshot.id, snapshot.split);
    });
  }

  async save(recurring: RecurringExpense): Promise<void> {
    const { id, next, version } = recurring.toSnapshot();
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      this.#checkVersion(id, version);
      connection
        .prepare('UPDATE ledger_recurring_expenses SET next = ?, version = ? WHERE id = ?')
        .run(next, version + 1, id);
    });
  }

  async remove(recurring: RecurringExpense): Promise<void> {
    const { id, version } = recurring.toSnapshot();
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      this.#checkVersion(id, version);
      connection.prepare('DELETE FROM ledger_recurring_shares WHERE recurring_id = ?').run(id);
      connection.prepare('DELETE FROM ledger_recurring_expenses WHERE id = ?').run(id);
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.file.transaction(work);
  }

  async recurringOf(id: string): Promise<RecurringExpenseView | undefined> {
    const row = this.database.connection
      .prepare(`SELECT ${RECURRING_COLUMNS} FROM ledger_recurring_expenses WHERE id = ?`)
      .get(id) as RecurringRow | undefined;
    return row ? this.#viewOf(row) : undefined;
  }

  async recurringsOf(groupId: string): Promise<RecurringExpenseView[]> {
    const rows = this.database.connection
      .prepare(`SELECT ${RECURRING_COLUMNS} FROM ledger_recurring_expenses WHERE group_id = ? ORDER BY rowid`)
      .all(groupId) as RecurringRow[];
    return rows.map(row => this.#viewOf(row));
  }

  #checkVersion(id: string, version: number): void {
    const stored = this.database.connection
      .prepare('SELECT version FROM ledger_recurring_expenses WHERE id = ?')
      .get(id) as { version: number } | undefined;
    if (!stored || stored.version !== version) {
      throw new ConcurrencyConflictException('Ledger', 'The recurring expense changed since it was read');
    }
  }

  #insertShares(recurringId: string, split: SplitRequest): void {
    const insert = this.database.connection.prepare(
      'INSERT INTO ledger_recurring_shares (recurring_id, position, member_id, share_value) VALUES (?, ?, ?, ?)',
    );
    const lines = this.#linesOf(split);
    lines.forEach((line, position) => insert.run(recurringId, position, line.memberId, line.value));
  }

  /** The split's members, each with the number it was given: nothing for an equal split, the amount or the shares otherwise. */
  #linesOf(split: SplitRequest): { memberId: string; value: number }[] {
    if (split.kind === 'equal') return split.memberIds.map(memberId => ({ memberId, value: 0 }));
    if (split.kind === 'exact') return split.amounts.map(({ memberId, amount }) => ({ memberId, value: amount }));
    return split.shares.map(({ memberId, shares }) => ({ memberId, value: shares }));
  }

  #sharesOf(recurringId: string): ShareRow[] {
    return this.database.connection
      .prepare('SELECT member_id, share_value FROM ledger_recurring_shares WHERE recurring_id = ? ORDER BY position')
      .all(recurringId) as ShareRow[];
  }

  #splitOf(row: RecurringRow): SplitRequest {
    const lines = this.#sharesOf(row.id);
    if (row.split_kind === 'equal') return { kind: 'equal', memberIds: lines.map(line => line.member_id) };
    if (row.split_kind === 'exact') {
      return { kind: 'exact', amounts: lines.map(line => ({ memberId: line.member_id, amount: line.share_value })) };
    }
    return { kind: 'shares', shares: lines.map(line => ({ memberId: line.member_id, shares: line.share_value })) };
  }

  #snapshotOf(row: RecurringRow): RecurringExpenseSnapshot {
    return {
      id: row.id,
      groupId: row.group_id,
      paidBy: row.paid_by,
      description: row.description,
      amount: row.amount,
      startsOn: row.starts_on,
      next: row.next,
      split: this.#splitOf(row),
      category: row.category,
      version: row.version,
    };
  }

  #viewOf(row: RecurringRow): RecurringExpenseView {
    const split = this.#splitOf(row);
    const view: RecurringExpenseView = {
      id: row.id,
      groupId: row.group_id,
      paidBy: row.paid_by,
      description: row.description,
      amount: row.amount,
      startsOn: row.starts_on,
      next: row.next,
      category: row.category,
    };
    if (split.kind === 'equal') return { ...view, splitBetween: [...split.memberIds] };
    if (split.kind === 'exact') return { ...view, splitExactly: split.amounts.map(line => ({ ...line })) };
    return { ...view, splitByShares: split.shares.map(line => ({ ...line })) };
  }
}
