import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';
import { IExpenseQueries } from '@Contexts/Ledger/Application/Ports/IExpenseQueries';
import { ExpenseReadModel, ExpenseShareReadModel } from '@Contexts/Ledger/Application/ReadModel/ExpenseReadModel';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface Row {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  split_kind: 'equal' | 'exact' | 'shares';
  version: number;
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
  category: CategoryName;
}

interface ShareRow {
  expense_id: string;
  member_id: string;
  amount: number;
}

const SELECT_EXPENSES = `SELECT id, group_id, description, amount, spent_on, paid_by, split_kind, version,
                                original_currency, original_amount, original_rate, category FROM expenses`;

/** The expenses' read models: read outside any command's transaction, so it waits for the one in progress. */
export class SqliteExpenseReadModels implements IExpenseQueries {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async findById(id: string): Promise<ExpenseReadModel | null> {
    return this.database.exclusive(() => {
      const row = this.database.get<Row>(`${SELECT_EXPENSES} WHERE id = ?`, id);
      if (!row) return null;
      const shares = this.database.all<ShareRow>(
        'SELECT expense_id, member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position',
        id,
      );
      return toReadModel(row, sharesOf(shares).get(id) ?? []);
    });
  }

  async ofGroup(groupId: string): Promise<ExpenseReadModel[]> {
    return this.database.exclusive(() => {
      const rows = this.database.all<Row>(`${SELECT_EXPENSES} WHERE group_id = ? ORDER BY recorded_seq`, groupId);
      const shares = sharesOf(
        this.database.all<ShareRow>(
          `SELECT expense_id, member_id, amount FROM expense_shares
           WHERE expense_id IN (SELECT id FROM expenses WHERE group_id = ?) ORDER BY expense_id, position`,
          groupId,
        ),
      );
      return rows.map(row => toReadModel(row, shares.get(row.id) ?? []));
    });
  }
}

/** The shares of many expenses, grouped by expense, each list in the order the split was given. */
function sharesOf(rows: ShareRow[]): Map<string, ExpenseShareReadModel[]> {
  const byExpense = new Map<string, ExpenseShareReadModel[]>();
  for (const row of rows) {
    const shares = byExpense.get(row.expense_id) ?? [];
    shares.push({ memberId: row.member_id, amount: row.amount });
    byExpense.set(row.expense_id, shares);
  }
  return byExpense;
}

function toReadModel(row: Row, shares: ExpenseShareReadModel[]): ExpenseReadModel {
  const model: ExpenseReadModel = {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    date: row.spent_on,
    paidBy: row.paid_by,
    splitKind: row.split_kind,
    version: row.version,
    category: row.category,
    shares,
  };
  // An expense in the group's currency has no `original`: the read says so by leaving it out.
  if (row.original_currency !== null) {
    model.original = {
      currency: row.original_currency,
      amount: row.original_amount ?? 0,
      rate: row.original_rate ?? '',
    };
  }
  return model;
}
