import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  IRecurringExpenseStore,
  RecurringExpenseView,
  RecurringSplitView,
} from '@Contexts/Ledger/Application/IRecurringExpenseStore';
import { RecurringExpense, RecurringExpenseSnapshot } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';
import { SplitDraft } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The recurring expenses' table (request 23, ADR 18). One row per recurring expense: its group, payer, description, amount, `startsOn`
 * and `next`, its split as it was given (`split`, the draft as JSON, in the order given), when it was set up (`set_up_at`, the order the
 * lists keep), and the version it is stored at, updated only while it is still at the version the aggregate was loaded at. The row is
 * taken out when it is stopped or ends. Created by `CREATE TABLE IF NOT EXISTS`, as every table of this application is.
 */
export const recurringExpensesTablesSchema = [
  `CREATE TABLE IF NOT EXISTS recurring_expenses (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL,
     paid_by TEXT NOT NULL,
     description TEXT NOT NULL,
     amount INTEGER NOT NULL,
     starts_on TEXT NOT NULL,
     next TEXT NOT NULL,
     split TEXT NOT NULL,
     set_up_at TEXT NOT NULL,
     version INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS recurring_expenses_by_group ON recurring_expenses (group_id, set_up_at)',
  'CREATE INDEX IF NOT EXISTS recurring_expenses_by_next ON recurring_expenses (next)',
];

interface RecurringRow {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  starts_on: string;
  next: string;
  split: string;
  set_up_at: string;
  version: number;
}

/** A split as a read shows it: the name the request gives its way, and its entries in the order given. */
const splitViewOf = (split: SplitDraft): RecurringSplitView => {
  if (split.kind === 'equal') return { splitBetween: [...split.memberIds] };
  if (split.kind === 'exact')
    return { splitExactly: split.amounts.map(({ memberId, amount }) => ({ memberId, amount })) };
  return { splitByShares: split.shares.map(({ memberId, shares }) => ({ memberId, shares })) };
};

/**
 * The recurring expenses in SQLite. `add` writes a new one at version 1; `save` and `remove` write it only while it is still at the
 * version it was loaded at, and refuse it with a ConcurrencyConflictException otherwise (the optimistic check, CONC-OPTIMISTIC). `viewOf`
 * and `listOf` read committed rows, the latter the earliest set up first; `dueBy` reads the rows whose `next` is no later than the day.
 */
export class SqliteRecurringExpenseStore implements IRecurringExpenseStore {
  constructor(private readonly database: SqliteDatabase) {}

  async add(recurring: RecurringExpense): Promise<void> {
    const snapshot = recurring.toSnapshot();
    this.database.writer
      .prepare(
        'INSERT INTO recurring_expenses (id, group_id, paid_by, description, amount, starts_on, next, split, set_up_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        snapshot.id,
        snapshot.groupId,
        snapshot.paidBy,
        snapshot.description,
        snapshot.amount,
        snapshot.startsOn,
        snapshot.next,
        JSON.stringify(snapshot.split),
        snapshot.setUpAt,
        snapshot.version + 1,
      );
  }

  async findById(recurringId: string): Promise<RecurringExpense | undefined> {
    const row = this.#rowOf(recurringId);
    return row ? RecurringExpense.fromSnapshot(this.#snapshotOf(row)) : undefined;
  }

  async save(recurring: RecurringExpense): Promise<void> {
    const snapshot = recurring.toSnapshot();
    const { changes } = this.database.writer
      .prepare('UPDATE recurring_expenses SET next = ?, version = ? WHERE id = ? AND version = ?')
      .run(snapshot.next, snapshot.version + 1, snapshot.id, snapshot.version);
    if (changes === 0) this.#conflict();
  }

  async remove(recurring: RecurringExpense): Promise<void> {
    const snapshot = recurring.toSnapshot();
    const { changes } = this.database.writer
      .prepare('DELETE FROM recurring_expenses WHERE id = ? AND version = ?')
      .run(snapshot.id, snapshot.version);
    if (changes === 0) this.#conflict();
  }

  async viewOf(recurringId: string): Promise<RecurringExpenseView | undefined> {
    const row = this.#rowOf(recurringId);
    return row ? this.#viewFrom(row) : undefined;
  }

  async listOf(groupId: string): Promise<RecurringExpenseView[]> {
    const rows = this.database.writer
      .prepare('SELECT * FROM recurring_expenses WHERE group_id = ? ORDER BY set_up_at, rowid')
      .all(groupId) as unknown as RecurringRow[];
    return rows.map(row => this.#viewFrom(row));
  }

  async dueBy(day: string): Promise<RecurringExpense[]> {
    const rows = this.database.writer
      .prepare('SELECT * FROM recurring_expenses WHERE next <= ? ORDER BY set_up_at, rowid')
      .all(day) as unknown as RecurringRow[];
    return rows.map(row => RecurringExpense.fromSnapshot(this.#snapshotOf(row)));
  }

  #rowOf(recurringId: string): RecurringRow | undefined {
    return this.database.writer.prepare('SELECT * FROM recurring_expenses WHERE id = ?').get(recurringId) as
      RecurringRow | undefined;
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
      split: JSON.parse(row.split) as SplitDraft,
      setUpAt: row.set_up_at,
      version: row.version,
    };
  }

  #viewFrom(row: RecurringRow): RecurringExpenseView {
    return {
      id: row.id,
      groupId: row.group_id,
      paidBy: row.paid_by,
      description: row.description,
      amount: row.amount,
      startsOn: row.starts_on,
      next: row.next,
      ...splitViewOf(JSON.parse(row.split) as SplitDraft),
    };
  }

  #conflict(): never {
    throw new ConcurrencyConflictException('Ledger', 'The recurring expense changed since it was read: read it again');
  }
}
