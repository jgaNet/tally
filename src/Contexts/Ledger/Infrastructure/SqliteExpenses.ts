import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Application/IExpenseRepository';
import {
  ExpenseView,
  IExpenseQueries,
  StatementEntryView,
  StatementView,
} from '@Contexts/Ledger/Application/IExpenseQueries';

import { LedgerDatabase } from './LedgerDatabase';

type ExpenseRow = {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  version: number;
  split_kind: 'equal' | 'exact' | 'shares';
};
type ShareRow = { member_id: string; amount: number };
type BalanceRow = { member_id: string; balance: number };
type Share = { memberId: string; amount: number };

/**
 * The expenses in SQLite: the repository `RecordExpense`, `EditExpense` and `DeleteExpense` load and write, and the read side
 * `GetExpense` and `GetGroupBalances` read. An expense and its shares are written in one transaction, so an expense never has
 * a share missing, and each balance moves in the same transaction as the expense it counts (feature 5).
 *
 * A save and a removal are conditional on the version the expense was read at (CONC-OPTIMISTIC, feature 6). The check and the
 * write happen in one transaction that holds the database's write lock, so of two writers from one version the second is
 * refused, and nothing of its change is kept.
 */
export class SqliteExpenses implements IExpenseRepository, IExpenseQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async get(id: string): Promise<Expense | undefined> {
    const view = await this.expenseOf(id);
    if (!view) return undefined;
    return Expense.fromSnapshot({
      id: view.id,
      groupId: view.groupId,
      description: view.description,
      amount: view.amount,
      date: view.date,
      paidBy: view.paidBy,
      splitKind: view.splitKind,
      shares: view.shares,
      version: view.version,
    });
  }

  async insert(expense: Expense): Promise<void> {
    const { id, groupId, description, amount, date, paidBy, splitKind, shares, version } = expense.toSnapshot();
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection
        .prepare(
          'INSERT INTO ledger_expenses (id, group_id, description, amount, date, paid_by, version, split_kind, recorded_seq) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(recorded_seq), 0) + 1 FROM ledger_expenses))',
        )
        .run(id, groupId, description, amount, date, paidBy, version + 1, splitKind);
      this.#insertShares(id, shares);
      this.#moveBalances(groupId, paidBy, amount, shares, 1);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async save(expense: Expense): Promise<void> {
    const { id, groupId, description, amount, date, paidBy, splitKind, shares, version } = expense.toSnapshot();
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      const stored = this.#storedAt(id, version);
      if (!stored) throw new ConcurrencyConflictException('Ledger', 'The expense changed since it was read');
      // The balances the stored expense counted are taken back, and the edited expense's counted, in this transaction.
      this.#moveBalances(groupId, stored.paid_by, stored.amount, this.#storedShares(id), -1);
      connection
        .prepare(
          'UPDATE ledger_expenses SET description = ?, amount = ?, date = ?, split_kind = ?, version = ? WHERE id = ?',
        )
        .run(description, amount, date, splitKind, version + 1, id);
      connection.prepare('DELETE FROM ledger_expense_shares WHERE expense_id = ?').run(id);
      this.#insertShares(id, shares);
      this.#moveBalances(groupId, paidBy, amount, shares, 1);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async remove(expense: Expense): Promise<void> {
    const { id, groupId, paidBy, amount, shares, version } = expense.toSnapshot();
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      if (!this.#storedAt(id, version))
        throw new ConcurrencyConflictException('Ledger', 'The expense changed since it was read');
      // The shares go first: they refer to the expense, and the database enforces that reference.
      connection.prepare('DELETE FROM ledger_expense_shares WHERE expense_id = ?').run(id);
      connection.prepare('DELETE FROM ledger_expenses WHERE id = ?').run(id);
      this.#moveBalances(groupId, paidBy, amount, shares, -1);
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async expenseOf(id: string): Promise<ExpenseView | undefined> {
    const connection = this.database.connection;
    const row = connection
      .prepare(
        'SELECT id, group_id, description, amount, date, paid_by, version, split_kind FROM ledger_expenses WHERE id = ?',
      )
      .get(id) as ExpenseRow | undefined;
    if (!row) return undefined;
    const shares = connection
      .prepare('SELECT member_id, amount FROM ledger_expense_shares WHERE expense_id = ? ORDER BY position')
      .all(id) as ShareRow[];
    return {
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.date,
      paidBy: row.paid_by,
      splitKind: row.split_kind,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
      version: row.version,
    };
  }

  async expensesOf(groupId: string): Promise<ExpenseView[]> {
    return this.#viewsOfGroup(groupId, true);
  }

  /**
   * The statement, read in one pass: the expenses the member paid or is in the split of, in the order of a bank statement
   * (the earliest date first, then the earliest recorded), each with what the member paid, their share, and the balance once
   * the entry is counted. The balance of the statement is the last entry's, or 0 when it has none.
   */
  async statementOf(groupId: string, memberId: string): Promise<StatementView> {
    const entries: StatementEntryView[] = [];
    let balance = 0;
    for (const expense of await this.#viewsOfGroup(groupId, false)) {
      const share = expense.shares.find(line => line.memberId === memberId);
      if (expense.paidBy !== memberId && !share) continue;
      const paid = expense.paidBy === memberId ? expense.amount : 0;
      const shared = share?.amount ?? 0;
      balance += paid - shared;
      entries.push({
        expenseId: expense.id,
        date: expense.date,
        description: expense.description,
        paid,
        share: shared,
        balance,
      });
    }
    return { memberId, balance, entries };
  }

  /** Every expense of the group, in the order of `latestFirst` (by date, then by when it was recorded), each with its shares. */
  #viewsOfGroup(groupId: string, latestFirst: boolean): ExpenseView[] {
    const direction = latestFirst ? 'DESC' : 'ASC';
    const connection = this.database.connection;
    const rows = connection
      .prepare(
        `SELECT id, group_id, description, amount, date, paid_by, version, split_kind FROM ledger_expenses
           WHERE group_id = ? ORDER BY date ${direction}, recorded_seq ${direction}`,
      )
      .all(groupId) as ExpenseRow[];
    const sharesByExpense = new Map<string, Share[]>();
    const shareRows = connection
      .prepare(
        `SELECT s.expense_id, s.member_id, s.amount FROM ledger_expense_shares s
           JOIN ledger_expenses e ON e.id = s.expense_id WHERE e.group_id = ? ORDER BY s.expense_id, s.position`,
      )
      .all(groupId) as (ShareRow & { expense_id: string })[];
    for (const row of shareRows) {
      const lines = sharesByExpense.get(row.expense_id) ?? [];
      lines.push({ memberId: row.member_id, amount: row.amount });
      sharesByExpense.set(row.expense_id, lines);
    }
    return rows.map(row => ({
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.date,
      paidBy: row.paid_by,
      splitKind: row.split_kind,
      shares: sharesByExpense.get(row.id) ?? [],
      version: row.version,
    }));
  }

  async balancesOf(groupId: string): Promise<ReadonlyMap<string, number>> {
    const rows = this.database.connection
      .prepare('SELECT member_id, balance FROM ledger_balances WHERE group_id = ?')
      .all(groupId) as BalanceRow[];
    return new Map(rows.map(row => [row.member_id, row.balance]));
  }

  /** The stored expense's payment and amount, if it is stored at `version`: the read the check of a write is made from. */
  #storedAt(id: string, version: number): { paid_by: string; amount: number } | undefined {
    return this.database.connection
      .prepare('SELECT paid_by, amount FROM ledger_expenses WHERE id = ? AND version = ?')
      .get(id, version) as { paid_by: string; amount: number } | undefined;
  }

  #storedShares(id: string): Share[] {
    const rows = this.database.connection
      .prepare('SELECT member_id, amount FROM ledger_expense_shares WHERE expense_id = ?')
      .all(id) as ShareRow[];
    return rows.map(row => ({ memberId: row.member_id, amount: row.amount }));
  }

  #insertShares(expenseId: string, shares: readonly Share[]): void {
    const insert = this.database.connection.prepare(
      'INSERT INTO ledger_expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
    );
    shares.forEach((share, position) => insert.run(expenseId, position, share.memberId, share.amount));
  }

  /** Moves the balances of a group by an expense: the payer is owed the amount, each member owes their share; `sign` 1 counts it, -1 takes it back. */
  #moveBalances(groupId: string, paidBy: string, amount: number, shares: readonly Share[], sign: 1 | -1): void {
    const move = this.database.connection.prepare(
      'INSERT INTO ledger_balances (group_id, member_id, balance) VALUES (?, ?, ?) ' +
        'ON CONFLICT (group_id, member_id) DO UPDATE SET balance = balance + excluded.balance',
    );
    move.run(groupId, paidBy, sign * amount);
    shares.forEach(share => move.run(groupId, share.memberId, -sign * share.amount));
  }
}
