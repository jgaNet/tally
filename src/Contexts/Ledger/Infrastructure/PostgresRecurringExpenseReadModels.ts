import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';
import { IRecurringExpenseQueries } from '@Contexts/Ledger/Application/Ports/IRecurringExpenseQueries';
import { RecurringExpenseReadModel } from '@Contexts/Ledger/Application/ReadModel/RecurringExpenseReadModel';
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
  category: CategoryName;
}

interface SplitRow {
  recurring_id: string;
  member_id: string;
  amount: number | null;
  shares: number | null;
}

const SELECT_RECURRING = `SELECT id, group_id, paid_by, description, amount, starts_on, next_on, split_kind, category FROM recurring_expenses`;

/** The recurring expenses' read models: read outside any command's transaction, so it waits for the one in progress. */
export class PostgresRecurringExpenseReadModels implements IRecurringExpenseQueries {
  constructor(private database: PostgresDatabase) {
    createLedgerTables(database);
  }

  async findById(id: string): Promise<RecurringExpenseReadModel | null> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<Row>(`${SELECT_RECURRING} WHERE id = ?`, id);
      if (!row) return null;
      return (await this.read([row]))[0];
    });
  }

  async ofGroup(groupId: string): Promise<RecurringExpenseReadModel[]> {
    return this.database.exclusive(async () =>
      this.read(await this.database.all<Row>(`${SELECT_RECURRING} WHERE group_id = ? ORDER BY set_up_seq`, groupId)),
    );
  }

  /** The rows read with their splits, each as it was given: the split's kind names which of the three it is. */
  private async read(rows: Row[]): Promise<RecurringExpenseReadModel[]> {
    if (!rows.length) return [];
    const placeholders = rows.map(() => '?').join(', ');
    const splits = await this.database.all<SplitRow>(
      `SELECT recurring_id, member_id, amount, shares FROM recurring_expense_splits
       WHERE recurring_id IN (${placeholders}) ORDER BY recurring_id, position`,
      ...rows.map(row => row.id),
    );
    return rows.map(row => {
      const mine = splits.filter(split => split.recurring_id === row.id);
      const base = {
        id: row.id,
        groupId: row.group_id,
        paidBy: row.paid_by,
        description: row.description,
        amount: row.amount,
        startsOn: row.starts_on,
        next: row.next_on,
        category: row.category,
      };
      switch (row.split_kind) {
        case 'equal':
          return { ...base, splitBetween: mine.map(split => split.member_id) };
        case 'exact':
          return {
            ...base,
            splitExactly: mine.map(split => ({ memberId: split.member_id, amount: split.amount ?? 0 })),
          };
        case 'shares':
          return {
            ...base,
            splitByShares: mine.map(split => ({ memberId: split.member_id, shares: split.shares ?? 0 })),
          };
      }
    });
  }
}
