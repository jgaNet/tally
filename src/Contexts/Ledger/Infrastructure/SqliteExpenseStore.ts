import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IExpenseStore, ExpenseView, MemberBalanceView } from '@Contexts/Ledger/Application/IExpenseStore';
import { Expense, ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Share } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The ledger's tables. An expense is a row of `expenses` (feature 4), and its shares are rows of `expense_shares`, in the
 * order the split was given (`position`), kept as they were decided. The group an expense is in is a group of Groups; the
 * ledger reads the membership through its port, not this table, so the foreign key only names the group's id.
 *
 * `expense_balances` is the read model of the balances (feature 5, the storm's hot spot): one row per member an expense
 * counts, holding what that expense does to the member's balance (what they paid, less their share). It is written in the
 * expense's own transaction, so a sum is never read half-written, and each expense's rows add up to 0 by construction. The
 * last statement fills it for the expenses kept before it existed: an expense without rows gets the rows its shares give,
 * once; `INSERT OR IGNORE` and the key keep a second server's run from counting an expense twice.
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
  `CREATE TABLE IF NOT EXISTS expense_balances (
     expense_id TEXT NOT NULL REFERENCES expenses(id),
     group_id TEXT NOT NULL,
     member_id TEXT NOT NULL,
     amount INTEGER NOT NULL,
     PRIMARY KEY (expense_id, member_id)
   )`,
  'CREATE INDEX IF NOT EXISTS expense_balances_by_group ON expense_balances (group_id, member_id)',
  `INSERT OR IGNORE INTO expense_balances (expense_id, group_id, member_id, amount)
     SELECT e.id, e.group_id, s.member_id,
            CASE WHEN s.member_id = e.paid_by THEN e.amount ELSE 0 END - s.amount
       FROM expenses e JOIN expense_shares s ON s.expense_id = e.id
      WHERE NOT EXISTS (SELECT 1 FROM expense_balances b WHERE b.expense_id = e.id)`,
];

/**
 * The expenses in SQLite. `add` writes the expense, its shares and the balances it counts inside the command's transaction;
 * `viewOf` reads the committed data, shares in the order they were decided; `balancesOf` sums the committed balance rows.
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

    // What the expense does to each member's balance: the payer is owed the whole amount, each member owes their share.
    // The payer is among the shares (Expense.register says so), so the rows add up to amount - amount = 0.
    const effect = new Map<string, number>([[snapshot.paidBy, snapshot.amount]]);
    for (const share of snapshot.shares) effect.set(share.memberId, (effect.get(share.memberId) ?? 0) - share.amount);
    for (const [memberId, amount] of effect) {
      this.database.writer
        .prepare('INSERT INTO expense_balances (expense_id, group_id, member_id, amount) VALUES (?, ?, ?, ?)')
        .run(snapshot.id, snapshot.groupId, memberId, amount);
    }
  }

  async balancesOf(groupId: string): Promise<MemberBalanceView[]> {
    const rows = this.database.read(db =>
      db
        .prepare('SELECT member_id, SUM(amount) AS balance FROM expense_balances WHERE group_id = ? GROUP BY member_id')
        .all(groupId),
    ) as unknown as BalanceRow[];
    return rows.map(row => ({ memberId: row.member_id, balance: row.balance }));
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

interface BalanceRow {
  member_id: string;
  balance: number;
}
