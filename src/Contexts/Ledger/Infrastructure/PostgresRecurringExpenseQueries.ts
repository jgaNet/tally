import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { SplitInput } from '@Contexts/Ledger/Domain/Expense/Split';
import { RecurringExpenseView } from '@Contexts/Ledger/Domain/RecurringExpense/DTOs';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Domain/RecurringExpense/Ports/IRecurringExpenseQueries';
import {
  RECURRING_COLUMNS,
  RecurringRow,
  prepareRecurringSchema,
  recurringSnapshotOf,
} from '@Contexts/Ledger/Infrastructure/PostgresRecurringExpenses';

/**
 * The read side of the recurring expenses over PostgreSQL: reads taken alone, outside any transaction (docs/adr/0022).
 * The split is answered as it was given, under the name the API gives it (request 23).
 */
export class PostgresRecurringExpenseQueries implements IRecurringExpenseQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareRecurringSchema);
  }

  async findRecurring(recurringId: string): Promise<RecurringExpenseView | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<RecurringRow>(
        `SELECT ${RECURRING_COLUMNS} FROM recurring_expenses WHERE id = ?`,
        [recurringId],
      );
      return row && viewOf(row);
    });
  }

  async listOf(groupId: string): Promise<RecurringExpenseView[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<RecurringRow>(
          `SELECT ${RECURRING_COLUMNS} FROM recurring_expenses WHERE group_id = ? ORDER BY seq`,
          [groupId],
        )
      ).map(viewOf),
    );
  }

  async dueOn(day: string): Promise<string[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<{ id: string }>('SELECT id FROM recurring_expenses WHERE next <= ? ORDER BY seq', [day])
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
    category: snapshot.category,
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
