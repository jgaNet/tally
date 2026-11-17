import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IExpenseStore, ExpenseView } from '@Contexts/Ledger/Application/IExpenseStore';
import { Expense, ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Share } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The ledger's tables (feature 4): an expense is a row of `expenses`, and its shares are rows of `expense_shares`, in the
 * order the split was given (`position`), kept as they were decided. The group an expense is in is a group of Groups; the
 * ledger reads the membership through its port, not this table, so the foreign key only names the group's id.
 */
export const ledgerTablesSchema = [
  `CREATE TABLE IF NOT EXISTS expenses (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL REFERENCES groups(id),
     description TEXT NOT NULL,
     amount INTEGER NOT NULL,
     spent_on TEXT NOT NULL,
     paid_by TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS expense_shares (
     expense_id TEXT NOT NULL REFERENCES expenses(id),
     position INTEGER NOT NULL,
     member_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     PRIMARY KEY (expense_id, position)
   )`,
  'CREATE INDEX IF NOT EXISTS expenses_by_group ON expenses (group_id)',
];

/**
 * The expenses in SQLite. `add` writes the expense and its shares inside the command's transaction; `viewOf` reads the
 * committed data, shares in the order they were decided.
 */
export class SqliteExpenseStore implements IExpenseStore {
  constructor(private readonly database: SqliteDatabase) {}

  async add(expense: Expense): Promise<void> {
    const snapshot: ExpenseSnapshot = expense.toSnapshot();
    this.database.writer
      .prepare('INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(snapshot.id, snapshot.groupId, snapshot.description, snapshot.amount, snapshot.date, snapshot.paidBy);
    snapshot.shares.forEach((share: Share, position) => {
      this.database.writer
        .prepare('INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)')
        .run(snapshot.id, position, share.memberId, share.amount);
    });
  }

  async viewOf(expenseId: string): Promise<ExpenseView | undefined> {
    const row = this.database.read(db =>
      db
        .prepare('SELECT id, group_id, description, amount, spent_on, paid_by FROM expenses WHERE id = ?')
        .get(expenseId),
    ) as ExpenseRow | undefined;
    if (!row) return undefined;

    const shares = this.database.read(db =>
      db.prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position').all(expenseId),
    ) as unknown as ShareRow[];
    return {
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.spent_on,
      paidBy: row.paid_by,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
    };
  }
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
}

interface ShareRow {
  member_id: string;
  amount: number;
}
