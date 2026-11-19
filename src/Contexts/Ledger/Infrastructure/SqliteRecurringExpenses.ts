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
 * The recurring expenses in PostgreSQL (request 23): the repository the set-up, stop and sweep use cases load and write, and the read side the
 * reads use. A recurring expense and its split are written in one transaction. A save or a removal is conditional on the version it was
 * read at (CONC-OPTIMISTIC): the check and the write are one transaction, so of two writers from one version the second is refused and keeps
 * nothing of its change.
 */
export class SqliteRecurringExpenses implements IRecurringExpenseRepository, IRecurringExpenseQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async get(id: string): Promise<RecurringExpense | undefined> {
    const row = await this.database.row<RecurringRow>(
      `SELECT ${RECURRING_COLUMNS} FROM ledger_recurring_expenses WHERE id = $1`,
      [id],
    );
    return row ? RecurringExpense.fromSnapshot(await this.#snapshotOf(row)) : undefined;
  }

  async all(): Promise<RecurringExpense[]> {
    const rows = await this.database.rows<RecurringRow>(
      `SELECT ${RECURRING_COLUMNS} FROM ledger_recurring_expenses ORDER BY seq`,
    );
    return Promise.all(rows.map(async row => RecurringExpense.fromSnapshot(await this.#snapshotOf(row))));
  }

  async insert(recurring: RecurringExpense): Promise<void> {
    const snapshot = recurring.toSnapshot();
    await this.database.transaction(async () => {
      await this.database.execute(
        'INSERT INTO ledger_recurring_expenses (id, group_id, paid_by, description, amount, starts_on, next, split_kind, category, version) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
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
        ],
      );
      await this.#insertShares(snapshot.id, snapshot.split);
    });
  }

  async save(recurring: RecurringExpense): Promise<void> {
    const { id, next, version } = recurring.toSnapshot();
    await this.database.transaction(async () => {
      await this.#checkVersion(id, version);
      await this.database.execute('UPDATE ledger_recurring_expenses SET next = $1, version = $2 WHERE id = $3', [
        next,
        version + 1,
        id,
      ]);
    });
  }

  async remove(recurring: RecurringExpense): Promise<void> {
    const { id, version } = recurring.toSnapshot();
    await this.database.transaction(async () => {
      await this.#checkVersion(id, version);
      await this.database.execute('DELETE FROM ledger_recurring_shares WHERE recurring_id = $1', [id]);
      await this.database.execute('DELETE FROM ledger_recurring_expenses WHERE id = $1', [id]);
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async recurringOf(id: string): Promise<RecurringExpenseView | undefined> {
    const row = await this.database.row<RecurringRow>(
      `SELECT ${RECURRING_COLUMNS} FROM ledger_recurring_expenses WHERE id = $1`,
      [id],
    );
    return row ? this.#viewOf(row) : undefined;
  }

  async ofGroup(groupId: string): Promise<RecurringExpense[]> {
    const rows = await this.database.rows<{ id: string }>(
      'SELECT id FROM ledger_recurring_expenses WHERE group_id = $1 ORDER BY seq',
      [groupId],
    );
    const recurrings: RecurringExpense[] = [];
    for (const { id } of rows) {
      const recurring = await this.get(id);
      if (recurring) recurrings.push(recurring);
    }
    return recurrings;
  }

  async saveMoved(recurring: RecurringExpense): Promise<void> {
    const { id, groupId, version } = recurring.toSnapshot();
    await this.database.transaction(async () => {
      await this.#checkVersion(id, version);
      await this.database.execute('UPDATE ledger_recurring_expenses SET group_id = $1 WHERE id = $2', [groupId, id]);
    });
  }

  async recurringsOf(groupId: string): Promise<RecurringExpenseView[]> {
    const rows = await this.database.rows<RecurringRow>(
      `SELECT ${RECURRING_COLUMNS} FROM ledger_recurring_expenses WHERE group_id = $1 ORDER BY seq`,
      [groupId],
    );
    return Promise.all(rows.map(row => this.#viewOf(row)));
  }

  async #checkVersion(id: string, version: number): Promise<void> {
    const stored = await this.database.row<{ version: number }>(
      'SELECT version FROM ledger_recurring_expenses WHERE id = $1',
      [id],
    );
    if (!stored || stored.version !== version) {
      throw new ConcurrencyConflictException('Ledger', 'The recurring expense changed since it was read');
    }
  }

  async #insertShares(recurringId: string, split: SplitRequest): Promise<void> {
    const lines = this.#linesOf(split);
    for (const [position, line] of lines.entries()) {
      await this.database.execute(
        'INSERT INTO ledger_recurring_shares (recurring_id, position, member_id, share_value) VALUES ($1, $2, $3, $4)',
        [recurringId, position, line.memberId, line.value],
      );
    }
  }

  /** The split's members, each with the number it was given: nothing for an equal split, the amount or the shares otherwise. */
  #linesOf(split: SplitRequest): { memberId: string; value: number }[] {
    if (split.kind === 'equal') return split.memberIds.map(memberId => ({ memberId, value: 0 }));
    if (split.kind === 'exact') return split.amounts.map(({ memberId, amount }) => ({ memberId, value: amount }));
    return split.shares.map(({ memberId, shares }) => ({ memberId, value: shares }));
  }

  async #sharesOf(recurringId: string): Promise<ShareRow[]> {
    return this.database.rows<ShareRow>(
      'SELECT member_id, share_value FROM ledger_recurring_shares WHERE recurring_id = $1 ORDER BY position',
      [recurringId],
    );
  }

  async #splitOf(row: RecurringRow): Promise<SplitRequest> {
    const lines = await this.#sharesOf(row.id);
    if (row.split_kind === 'equal') return { kind: 'equal', memberIds: lines.map(line => line.member_id) };
    if (row.split_kind === 'exact') {
      return { kind: 'exact', amounts: lines.map(line => ({ memberId: line.member_id, amount: line.share_value })) };
    }
    return { kind: 'shares', shares: lines.map(line => ({ memberId: line.member_id, shares: line.share_value })) };
  }

  async #snapshotOf(row: RecurringRow): Promise<RecurringExpenseSnapshot> {
    return {
      id: row.id,
      groupId: row.group_id,
      paidBy: row.paid_by,
      description: row.description,
      amount: row.amount,
      startsOn: row.starts_on,
      next: row.next,
      split: await this.#splitOf(row),
      category: row.category,
      version: row.version,
    };
  }

  async #viewOf(row: RecurringRow): Promise<RecurringExpenseView> {
    const split = await this.#splitOf(row);
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
