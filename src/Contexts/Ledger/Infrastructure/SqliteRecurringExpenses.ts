import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpenseSnapshot } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';
import { IRecurringExpenses } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenses';
import { RecurringExpense } from '@Contexts/Ledger/Domain/RecurringExpense/RecurringExpense';

/**
 * The recurring expenses' table (request 23, docs/adr/0022): one row each, the split as it was given kept as JSON, and the
 * row's insertion order, which is the order they were set up in.
 */
export const RECURRING_SCHEMA =
  'CREATE TABLE IF NOT EXISTS recurring_expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, paid_by TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, starts_on TEXT NOT NULL, next TEXT NOT NULL, split_json TEXT NOT NULL, version INTEGER NOT NULL)';

/** A recurring expense's row, as the store reads it. */
export type RecurringRow = {
  id: string;
  group_id: string;
  paid_by: string;
  description: string;
  amount: number;
  starts_on: string;
  next: string;
  split_json: string;
  version: number;
};

/** The columns a recurring expense row is read by, in the order `RecurringRow` lists them. */
export const RECURRING_COLUMNS = 'id, group_id, paid_by, description, amount, starts_on, next, split_json, version';

/** The snapshot a row keeps: the aggregate is read back from it, and checks what it is given (docs/adr/0022). */
export function recurringSnapshotOf(row: RecurringRow): RecurringExpenseSnapshot {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    paidBy: String(row.paid_by),
    description: String(row.description),
    amount: Number(row.amount),
    startsOn: String(row.starts_on),
    next: String(row.next),
    split: JSON.parse(String(row.split_json)) as SplitInput,
    version: Number(row.version),
  };
}

/**
 * The store of recurring expenses over SQLite. Its methods run inside a transaction: the use case's. A save or a removal of a
 * recurring expense read at a version another writer has moved past changes nothing and answers a conflict (CONC-OPTIMISTIC):
 * two servers running the job for the same day cannot both record it.
 */
export class SqliteRecurringExpenses implements IRecurringExpenses {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(RECURRING_SCHEMA));
  }

  async get(recurringId: string): Promise<RecurringExpense | undefined> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare(`SELECT ${RECURRING_COLUMNS} FROM recurring_expenses WHERE id = ?`)
      .get(recurringId) as RecurringRow | undefined;
    return row ? RecurringExpense.fromSnapshot(recurringSnapshotOf(row)) : undefined;
  }

  async save(recurring: RecurringExpense): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = recurring.toSnapshot();
    const connection = this.database.connection;
    if (snapshot.version === 0) {
      connection
        .prepare(`INSERT INTO recurring_expenses (${RECURRING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          snapshot.id,
          snapshot.groupId,
          snapshot.paidBy,
          snapshot.description,
          snapshot.amount,
          snapshot.startsOn,
          snapshot.next,
          JSON.stringify(snapshot.split),
          snapshot.version + 1,
        );
      return Result.ok(undefined);
    }
    const { changes } = connection
      .prepare('UPDATE recurring_expenses SET next = ?, version = ? WHERE id = ? AND version = ?')
      .run(snapshot.next, snapshot.version + 1, snapshot.id, snapshot.version);
    if (changes === 0) return Result.fail(changedSinceRead());
    return Result.ok(undefined);
  }

  async delete(recurring: RecurringExpense): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = recurring.toSnapshot();
    const { changes } = this.database.connection
      .prepare('DELETE FROM recurring_expenses WHERE id = ? AND version = ?')
      .run(snapshot.id, snapshot.version);
    if (changes === 0) return Result.fail(changedSinceRead());
    return Result.ok(undefined);
  }
}

const changedSinceRead = () =>
  new ConcurrencyConflictException('Ledger', 'The recurring expense changed since it was read');
