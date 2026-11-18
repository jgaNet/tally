import { ConcurrencyConflictException } from '@Architecture/Domain';
import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Application/IExpenseRepository';
import {
  ExpenseLineView,
  ExpenseView,
  IExpenseQueries,
  OriginalView,
} from '@Contexts/Ledger/Application/IExpenseQueries';

import { LedgerDatabase } from './LedgerDatabase';

type ExpenseRow = {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
  date: string;
  paid_by: string;
  version: number;
  split_kind: 'equal' | 'exact' | 'shares';
  category: ExpenseCategory;
};
/** The columns of an expense a read selects, in the order `expenseRow` maps them. */
const EXPENSE_COLUMNS =
  'id, group_id, description, amount, original_currency, original_amount, original_rate, date, paid_by, version, split_kind, category';
type ShareRow = { member_id: string; amount: number };
type ExpenseLineRow = {
  id: string;
  date: string;
  description: string;
  amount: number;
  paid_by: string;
  recorded_at: string;
  share: number | null;
};
type BalanceRow = { member_id: string; balance: number };
type Share = { memberId: string; amount: number };

/**
 * The expenses in PostgreSQL: the repository `RecordExpense`, `EditExpense` and `DeleteExpense` load and write, and the read side
 * `GetExpense` and `GetGroupBalances` read. An expense and its shares are written in one transaction, so an expense never has
 * a share missing, and each balance moves in the same transaction as the expense it counts (feature 5).
 *
 * A save and a removal are conditional on the version the expense was read at (CONC-OPTIMISTIC, feature 6). The check and the
 * write happen in one transaction that takes the database's writers' lock, so of two writers from one version the second is
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
      ...(view.original ? { original: { ...view.original } } : {}),
      date: view.date,
      paidBy: view.paidBy,
      splitKind: view.splitKind,
      shares: view.shares,
      category: view.category,
      version: view.version,
    });
  }

  async insert(expense: Expense, recordedAt: string): Promise<void> {
    const { id, groupId, description, amount, original, date, paidBy, splitKind, shares, category, version } =
      expense.toSnapshot();
    await this.database.transaction(async () => {
      await this.database.execute(
        'INSERT INTO ledger_expenses (id, group_id, description, amount, original_currency, original_amount, original_rate, ' +
          'date, paid_by, version, split_kind, category, recorded_seq, recorded_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, (SELECT COALESCE(MAX(recorded_seq), 0) + 1 FROM ledger_expenses), $13)',
        [
          id,
          groupId,
          description,
          amount,
          original?.currency ?? null,
          original?.amount ?? null,
          original?.rate ?? null,
          date,
          paidBy,
          version + 1,
          splitKind,
          category,
          recordedAt,
        ],
      );
      await this.#insertShares(id, shares);
      await this.#moveBalances(groupId, paidBy, amount, shares, 1);
    });
  }

  async save(expense: Expense): Promise<void> {
    const { id, groupId, description, amount, original, date, paidBy, splitKind, shares, category, version } =
      expense.toSnapshot();
    await this.database.transaction(async () => {
      const stored = await this.#storedAt(id, version);
      if (!stored) throw new ConcurrencyConflictException('Ledger', 'The expense changed since it was read');
      // The balances the stored expense counted are taken back, and the edited expense's counted, in this transaction.
      await this.#moveBalances(groupId, stored.paid_by, stored.amount, await this.#storedShares(id), -1);
      await this.database.execute(
        'UPDATE ledger_expenses SET description = $1, amount = $2, original_currency = $3, original_amount = $4, ' +
          'original_rate = $5, date = $6, split_kind = $7, category = $8, version = $9 WHERE id = $10',
        [
          description,
          amount,
          original?.currency ?? null,
          original?.amount ?? null,
          original?.rate ?? null,
          date,
          splitKind,
          category,
          version + 1,
          id,
        ],
      );
      await this.database.execute('DELETE FROM ledger_expense_shares WHERE expense_id = $1', [id]);
      await this.#insertShares(id, shares);
      await this.#moveBalances(groupId, paidBy, amount, shares, 1);
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async remove(expense: Expense): Promise<void> {
    const { id, groupId, paidBy, amount, shares, version } = expense.toSnapshot();
    await this.database.transaction(async () => {
      if (!(await this.#storedAt(id, version)))
        throw new ConcurrencyConflictException('Ledger', 'The expense changed since it was read');
      // The shares go first: they refer to the expense, and the database enforces that reference.
      await this.database.execute('DELETE FROM ledger_expense_shares WHERE expense_id = $1', [id]);
      await this.database.execute('DELETE FROM ledger_expenses WHERE id = $1', [id]);
      await this.#moveBalances(groupId, paidBy, amount, shares, -1);
    });
  }

  async expenseOf(id: string): Promise<ExpenseView | undefined> {
    const row = await this.database.row<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM ledger_expenses WHERE id = $1`, [
      id,
    ]);
    if (!row) return undefined;
    const shares = await this.database.rows<ShareRow>(
      'SELECT member_id, amount FROM ledger_expense_shares WHERE expense_id = $1 ORDER BY position',
      [id],
    );
    return viewOf(
      row,
      shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
    );
  }

  async expensesOf(groupId: string): Promise<ExpenseView[]> {
    return this.#viewsOfGroup(groupId, true);
  }

  /**
   * The expenses the member paid or is in the split of, read in one statement: each with what the member paid, their share, and when it was
   * recorded (request 29). The earliest date first, then the earliest recorded, by its instant and then by its order of recording; the balance
   * is not computed here, the statement merges these lines with the settlements.
   */
  async expenseLinesOf(groupId: string, memberId: string): Promise<ExpenseLineView[]> {
    const rows = await this.database.rows<ExpenseLineRow>(
      `SELECT e.id, e.date, e.description, e.amount, e.paid_by, e.recorded_at, s.amount AS share
         FROM ledger_expenses e
         LEFT JOIN ledger_expense_shares s ON s.expense_id = e.id AND s.member_id = $1
        WHERE e.group_id = $2 AND (e.paid_by = $1 OR s.member_id IS NOT NULL)
        ORDER BY e.date, e.recorded_at, e.recorded_seq`,
      [memberId, groupId],
    );
    return rows.map(row => ({
      expenseId: row.id,
      recordedAt: row.recorded_at,
      date: row.date,
      description: row.description,
      paid: row.paid_by === memberId ? row.amount : 0,
      share: row.share ?? 0,
    }));
  }

  /** Every expense of the group, in the order of `latestFirst` (by date, then by when it was recorded), each with its shares. */
  async #viewsOfGroup(groupId: string, latestFirst: boolean): Promise<ExpenseView[]> {
    const direction = latestFirst ? 'DESC' : 'ASC';
    const rows = await this.database.rows<ExpenseRow>(
      `SELECT ${EXPENSE_COLUMNS} FROM ledger_expenses
         WHERE group_id = $1 ORDER BY date ${direction}, recorded_seq ${direction}`,
      [groupId],
    );
    const sharesByExpense = new Map<string, Share[]>();
    const shareRows = await this.database.rows<ShareRow & { expense_id: string }>(
      `SELECT s.expense_id, s.member_id, s.amount FROM ledger_expense_shares s
         JOIN ledger_expenses e ON e.id = s.expense_id WHERE e.group_id = $1 ORDER BY s.expense_id, s.position`,
      [groupId],
    );
    for (const row of shareRows) {
      const lines = sharesByExpense.get(row.expense_id) ?? [];
      lines.push({ memberId: row.member_id, amount: row.amount });
      sharesByExpense.set(row.expense_id, lines);
    }
    return rows.map(row => viewOf(row, sharesByExpense.get(row.id) ?? []));
  }

  async spentByCategory(groupId: string, month: string): Promise<ReadonlyMap<ExpenseCategory, number>> {
    const rows = await this.database.rows<{ category: ExpenseCategory; spent: number }>(
      'SELECT category, CAST(SUM(amount) AS INTEGER) AS spent FROM ledger_expenses WHERE group_id = $1 AND substr(date, 1, 7) = $2 GROUP BY category',
      [groupId, month],
    );
    return new Map(rows.map(row => [row.category, row.spent]));
  }

  async isInvolved(groupId: string, memberId: string): Promise<boolean> {
    const rows = await this.database.rows(
      `SELECT 1 AS found FROM ledger_expenses e
         LEFT JOIN ledger_expense_shares s ON s.expense_id = e.id
        WHERE e.group_id = $1 AND (e.paid_by = $2 OR s.member_id = $2) LIMIT 1`,
      [groupId, memberId],
    );
    return rows.length > 0;
  }

  async balancesOf(groupId: string): Promise<ReadonlyMap<string, number>> {
    const rows = await this.database.rows<BalanceRow>(
      'SELECT member_id, balance FROM ledger_balances WHERE group_id = $1',
      [groupId],
    );
    return new Map(rows.map(row => [row.member_id, row.balance]));
  }

  /** The stored expense's payment and amount, if it is stored at `version`: the read the check of a write is made from. */
  async #storedAt(id: string, version: number): Promise<{ paid_by: string; amount: number } | undefined> {
    return this.database.row<{ paid_by: string; amount: number }>(
      'SELECT paid_by, amount FROM ledger_expenses WHERE id = $1 AND version = $2',
      [id, version],
    );
  }

  async #storedShares(id: string): Promise<Share[]> {
    const rows = await this.database.rows<ShareRow>(
      'SELECT member_id, amount FROM ledger_expense_shares WHERE expense_id = $1',
      [id],
    );
    return rows.map(row => ({ memberId: row.member_id, amount: row.amount }));
  }

  async #insertShares(expenseId: string, shares: readonly Share[]): Promise<void> {
    for (const [position, share] of shares.entries()) {
      await this.database.execute(
        'INSERT INTO ledger_expense_shares (expense_id, position, member_id, amount) VALUES ($1, $2, $3, $4)',
        [expenseId, position, share.memberId, share.amount],
      );
    }
  }

  /** Moves the balances of a group by an expense: the payer is owed the amount, each member owes their share; `sign` 1 counts it, -1 takes it back. */
  async #moveBalances(
    groupId: string,
    paidBy: string,
    amount: number,
    shares: readonly Share[],
    sign: 1 | -1,
  ): Promise<void> {
    const move = (memberId: string, delta: number) =>
      this.database.execute(
        'INSERT INTO ledger_balances (group_id, member_id, balance) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (group_id, member_id) DO UPDATE SET balance = ledger_balances.balance + EXCLUDED.balance',
        [groupId, memberId, delta],
      );
    await move(paidBy, sign * amount);
    for (const share of shares) await move(share.memberId, -sign * share.amount);
  }
}

/** An expense as a read answers it: its original is there only when it was paid in another currency (request 21). */
function viewOf(row: ExpenseRow, shares: Share[]): ExpenseView {
  const original: OriginalView | undefined =
    row.original_currency === null || row.original_amount === null || row.original_rate === null
      ? undefined
      : { currency: row.original_currency, amount: row.original_amount, rate: row.original_rate };
  return {
    id: row.id,
    groupId: row.group_id,
    description: row.description,
    amount: row.amount,
    ...(original ? { original } : {}),
    date: row.date,
    paidBy: row.paid_by,
    splitKind: row.split_kind,
    shares,
    category: row.category,
    version: row.version,
  };
}
