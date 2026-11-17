import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IExpenseStore, ExpenseView, MemberBalanceView } from '@Contexts/Ledger/Application/IExpenseStore';
import { Expense, ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/Expense';
import { Share, SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';

/**
 * The ledger's tables. An expense is a row of `expenses` (feature 4), and its shares are rows of `expense_shares`, in the
 * order the split was given (`position`), kept as they were decided. The group an expense is in is a group of Groups; the
 * ledger reads the membership through its port, not this table, so the foreign key only names the group's id.
 *
 * `expense_splits` is the way each expense was split, `equal`, `exact` or `shares` (feature 7): one row per expense, written with
 * the expense, and backfilled as `equal` for the expenses kept before feature 7, which were all split equally.
 *
 * `expense_versions` is the version each expense is stored at (feature 6, ADR 8): one row per expense, 1 when it is recorded
 * and one more at each edit, updated only while it is still at the version the aggregate was loaded at. It is a table of its
 * own so that the expenses kept before feature 6 get it from the statement below, once, without a change to `expenses`.
 *
 * `expense_balances` is the read model of the balances (feature 5, the storm's hot spot): one row per member an expense
 * counts, holding what that expense does to the member's balance (what they paid, less their share). It is written in the
 * expense's own transaction, so a sum is never read half-written, and each expense's rows add up to 0 by construction. An
 * edit replaces an expense's rows and a deletion takes them out, in the same transaction. The last statement fills it for
 * the expenses kept before it existed: an expense without rows gets the rows its shares give, once; `INSERT OR IGNORE` and
 * the key keep a second server's run from counting an expense twice.
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
  `CREATE TABLE IF NOT EXISTS expense_versions (
     expense_id TEXT PRIMARY KEY REFERENCES expenses(id),
     version INTEGER NOT NULL
   )`,
  `INSERT OR IGNORE INTO expense_versions (expense_id, version) SELECT id, 1 FROM expenses`,
  `CREATE TABLE IF NOT EXISTS expense_splits (
     expense_id TEXT PRIMARY KEY REFERENCES expenses(id),
     kind TEXT NOT NULL CHECK (kind IN ('equal', 'exact', 'shares'))
   )`,
  `INSERT OR IGNORE INTO expense_splits (expense_id, kind) SELECT id, 'equal' FROM expenses`,
];

/**
 * The expenses in SQLite. `add` writes the expense, its shares, its version and the balances it counts inside the command's
 * transaction; `findById` loads the expense as it was last saved; `save` and `remove` write an edited or deleted expense only
 * while it is still at the version it was loaded at (the optimistic check, ADR 8), refusing it with a
 * ConcurrencyConflictException when another writer changed it first; `viewOf` reads the committed data, shares in the order
 * they were decided; `balancesOf` sums the committed balance rows.
 */
export class SqliteExpenseStore implements IExpenseStore {
  constructor(private readonly database: SqliteDatabase) {}

  async add(expense: Expense): Promise<void> {
    const snapshot: ExpenseSnapshot = expense.toSnapshot();
    this.database.writer
      .prepare('INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(snapshot.id, snapshot.groupId, snapshot.description, snapshot.amount, snapshot.date, snapshot.paidBy);
    this.database.writer
      .prepare('INSERT INTO expense_versions (expense_id, version) VALUES (?, ?)')
      .run(snapshot.id, snapshot.version + 1);
    this.database.writer
      .prepare('INSERT INTO expense_splits (expense_id, kind) VALUES (?, ?)')
      .run(snapshot.id, snapshot.splitKind);
    this.#writeShares(snapshot);
    this.#writeBalances(snapshot);
  }

  async findById(expenseId: string): Promise<Expense | undefined> {
    const view = await this.viewOf(expenseId);
    if (!view) return undefined;
    return Expense.fromSnapshot(view);
  }

  async save(expense: Expense): Promise<void> {
    const snapshot: ExpenseSnapshot = expense.toSnapshot();
    this.#checkVersion(snapshot);
    this.database.writer
      .prepare('UPDATE expenses SET description = ?, amount = ?, spent_on = ? WHERE id = ?')
      .run(snapshot.description, snapshot.amount, snapshot.date, snapshot.id);
    this.database.writer
      .prepare('INSERT OR REPLACE INTO expense_splits (expense_id, kind) VALUES (?, ?)')
      .run(snapshot.id, snapshot.splitKind);
    this.database.writer.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(snapshot.id);
    this.#writeShares(snapshot);
    this.database.writer.prepare('DELETE FROM expense_balances WHERE expense_id = ?').run(snapshot.id);
    this.#writeBalances(snapshot);
  }

  async remove(expense: Expense): Promise<void> {
    const snapshot: ExpenseSnapshot = expense.toSnapshot();
    this.#checkVersion(snapshot);
    this.database.writer.prepare('DELETE FROM expense_balances WHERE expense_id = ?').run(snapshot.id);
    this.database.writer.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(snapshot.id);
    this.database.writer.prepare('DELETE FROM expense_versions WHERE expense_id = ?').run(snapshot.id);
    this.database.writer.prepare('DELETE FROM expense_splits WHERE expense_id = ?').run(snapshot.id);
    this.database.writer.prepare('DELETE FROM expenses WHERE id = ?').run(snapshot.id);
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
        .prepare(
          `SELECT e.id, e.group_id, e.description, e.amount, e.spent_on, e.paid_by, v.version, k.kind
             FROM expenses e
             JOIN expense_versions v ON v.expense_id = e.id
             JOIN expense_splits k ON k.expense_id = e.id
            WHERE e.id = ?`,
        )
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
      splitKind: row.kind,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
      version: row.version,
    };
  }

  /** Refuses the save or removal when another writer changed the expense since it was loaded (ADR 8). */
  #checkVersion(snapshot: ExpenseSnapshot): void {
    const { changes } = this.database.writer
      .prepare('UPDATE expense_versions SET version = ? WHERE expense_id = ? AND version = ?')
      .run(snapshot.version + 1, snapshot.id, snapshot.version);
    if (changes === 0) {
      throw new ConcurrencyConflictException('Ledger', 'The expense changed since it was read: read it again');
    }
  }

  #writeShares(snapshot: ExpenseSnapshot): void {
    snapshot.shares.forEach((share: Share, position) => {
      this.database.writer
        .prepare('INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)')
        .run(snapshot.id, position, share.memberId, share.amount);
    });
  }

  /** What the expense does to each member's balance: the payer is owed the whole amount, each member owes their share. */
  #writeBalances(snapshot: ExpenseSnapshot): void {
    // The payer is among the shares (Expense.register and edit say so), so the rows add up to amount - amount = 0.
    const effect = new Map<string, number>([[snapshot.paidBy, snapshot.amount]]);
    for (const share of snapshot.shares) effect.set(share.memberId, (effect.get(share.memberId) ?? 0) - share.amount);
    for (const [memberId, amount] of effect) {
      this.database.writer
        .prepare('INSERT INTO expense_balances (expense_id, group_id, member_id, amount) VALUES (?, ?, ?, ?)')
        .run(snapshot.id, snapshot.groupId, memberId, amount);
    }
  }
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  version: number;
  kind: SplitKind;
}

interface ShareRow {
  member_id: string;
  amount: number;
}

interface BalanceRow {
  member_id: string;
  balance: number;
}
