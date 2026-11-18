import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpenseView } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseQueries';
import {
  RECURRING_COLUMNS,
  RECURRING_SCHEMA,
  RecurringRow,
  recurringSnapshotOf,
} from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenses';

/**
 * The read side of the recurring expenses over SQLite: reads of the file, taken alone, outside any transaction (docs/adr/0022).
 * The split is answered as it was given, under the name the API gives it (request 23).
 */
export class SqliteRecurringExpenseQueries implements IRecurringExpenseQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(connection => connection.exec(RECURRING_SCHEMA));
  }

  async findRecurring(recurringId: string): Promise<RecurringExpenseView | undefined> {
    return this.database.exclusive(() => {
      const row = this.database.connection
        .prepare(`SELECT ${RECURRING_COLUMNS} FROM recurring_expenses WHERE id = ?`)
        .get(recurringId) as RecurringRow | undefined;
      return row && viewOf(row);
    });
  }

  async listOf(groupId: string): Promise<RecurringExpenseView[]> {
    return this.database.exclusive(() =>
      (
        this.database.connection
          .prepare(`SELECT ${RECURRING_COLUMNS} FROM recurring_expenses WHERE group_id = ? ORDER BY rowid`)
          .all(groupId) as RecurringRow[]
      ).map(viewOf),
    );
  }

  async dueOn(day: string): Promise<string[]> {
    return this.database.exclusive(() =>
      (
        this.database.connection
          .prepare('SELECT id FROM recurring_expenses WHERE next <= ? ORDER BY rowid')
          .all(day) as Array<{ id: string }>
      ).map(row => String(row.id)),
    );
  }
}

/** A row as the queries answer it: the snapshot's fields, and the one split key the split was given under. */
function viewOf(row: RecurringRow): RecurringExpenseView {
  const snapshot = recurringSnapshotOf(row);
  const base = {
    id: snapshot.id,
    groupId: snapshot.groupId,
    paidBy: snapshot.paidBy,
    description: snapshot.description,
    amount: snapshot.amount,
    startsOn: snapshot.startsOn,
    next: snapshot.next,
  };
  const split: SplitInput = snapshot.split;
  switch (split.kind) {
    case 'equal':
      return { ...base, splitBetween: split.between };
    case 'exact':
      return { ...base, splitExactly: split.amounts };
    case 'shares':
      return { ...base, splitByShares: split.shares };
  }
}
