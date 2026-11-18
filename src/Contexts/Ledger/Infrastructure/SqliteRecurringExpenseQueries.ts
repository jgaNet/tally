import type { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Application/Ports/IRecurringExpenseQueries';
import { RecurringReadModel } from '@Contexts/Ledger/Application/ReadModel/RecurringReadModel';
import { RECURRING_STATEMENTS } from '@Contexts/Ledger/Infrastructure/recurring.schema';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

interface RowOfRecurring {
  id: string;
  groupId: string;
  paidBy: string;
  description: string;
  amount: number;
  startsOn: string;
  next: string;
  splitKind: SplitKind;
  category: Category;
}

/** What the screens read of the recurring expenses, from the SQLite file, outside any transaction. */
export class SqliteRecurringExpenseQueries implements IRecurringExpenseQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(RECURRING_STATEMENTS);
  }

  findById(id: string): Promise<RecurringReadModel | null> {
    return this.database.exclusive(connection => {
      const row = connection
        .prepare(
          `SELECT id, group_id AS groupId, paid_by AS paidBy, description, amount, starts_on AS startsOn, next,
                  split_kind AS splitKind, COALESCE(c.category, 'other') AS category
             FROM ledger_recurring_expenses r LEFT JOIN ledger_recurring_categories c ON c.recurring_id = r.id
            WHERE r.id = ?`,
        )
        .get(id) as RowOfRecurring | undefined;
      if (!row) return null;
      return withSplit(row, membersOfRecurring(connection, row.id));
    });
  }

  listByGroup(groupId: string): Promise<RecurringReadModel[]> {
    return this.database.exclusive(connection => {
      // `rowid` is the order they were set up in: the earliest first.
      const rows = connection
        .prepare(
          `SELECT id, group_id AS groupId, paid_by AS paidBy, description, amount, starts_on AS startsOn, next,
                  split_kind AS splitKind, COALESCE(c.category, 'other') AS category
             FROM ledger_recurring_expenses r LEFT JOIN ledger_recurring_categories c ON c.recurring_id = r.id
            WHERE r.group_id = ? ORDER BY r.rowid`,
        )
        .all(groupId) as unknown as RowOfRecurring[];
      return rows.map(row => withSplit(row, membersOfRecurring(connection, row.id)));
    });
  }
}

/** The members of a recurring expense's split, in the order they were given, with what each was given with. */
function membersOfRecurring(connection: DatabaseSync, id: string): { memberId: string; given: number | null }[] {
  return connection
    .prepare(
      'SELECT member_id AS memberId, given FROM ledger_recurring_members WHERE recurring_id = ? ORDER BY position',
    )
    .all(id) as unknown as { memberId: string; given: number | null }[];
}

/** The split as it was given, in the one of its three forms that was given. */
function withSplit(row: RowOfRecurring, members: { memberId: string; given: number | null }[]): RecurringReadModel {
  const { splitKind, ...rest } = row;
  if (splitKind === 'equal') return { ...rest, splitBetween: members.map(member => member.memberId) };
  if (splitKind === 'exact') {
    return { ...rest, splitExactly: members.map(member => ({ memberId: member.memberId, amount: member.given ?? 0 })) };
  }
  return { ...rest, splitByShares: members.map(member => ({ memberId: member.memberId, shares: member.given ?? 0 })) };
}
