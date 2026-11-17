import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  BalanceView,
  ExpenseView,
  ShareSnapshot,
  SplitKind,
  StatementEntryView,
} from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { IGroupMembers, PassedBalances } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import {
  EXPENSE_COLUMNS,
  ExpenseRow,
  originalOfRow,
  prepareLedgerSchema,
} from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';

type ShareRow = { member_id: string; amount: number };
type GroupShareRow = ShareRow & { expense_id: string };
type BalanceRow = { member_id: string; balance: number };
type StatementRow = {
  expense_id: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
};

/** The read side of the expenses over SQLite: reads of the file, taken alone, outside any transaction (docs/adr/0004). */
export class SqliteExpenseQueries implements IExpenseQueries {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly settled: ISettledAmounts,
    private readonly groupMembers: IGroupMembers,
  ) {
    database.prepare(prepareLedgerSchema);
  }

  async findExpense(expenseId: string): Promise<ExpenseView | undefined> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const row = connection.prepare(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = ?`).get(expenseId) as
        ExpenseRow | undefined;
      if (!row) return undefined;
      const shares = connection
        .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
        .all(expenseId) as ShareRow[];
      return expenseView(row, shares);
    });
  }

  async balancesOf(groupId: string): Promise<BalanceView[]> {
    // What is settled is read first, outside the file's turn: a settlement is Settlements' rows, read on its own connection.
    // The expenses are one statement, so one snapshot: what a member paid, less their shares, over the group's expenses (docs/adr/0005).
    // Each member's balance then moves by what they settled (docs/adr/0013): a settlement paid moves the payer's balance up by its amount.
    const settled = await this.settled.settledOf(groupId);
    const expenses = await this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(
          `SELECT member_id, SUM(amount) AS balance FROM (
             SELECT paid_by AS member_id, amount FROM expenses WHERE group_id = ?
             UNION ALL
             SELECT s.member_id, -s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?
           ) GROUP BY member_id`,
        )
        .all(groupId, groupId) as BalanceRow[];
      return rows.map((row): BalanceView => ({ memberId: String(row.member_id), balance: Number(row.balance) }));
    });

    const balances = new Map<string, number>(expenses.map(({ memberId, balance }) => [memberId, balance]));
    for (const { memberId, amount } of settled) balances.set(memberId, (balances.get(memberId) ?? 0) + amount);
    // What the leaves passed is read after the expenses, on a connection of its own (docs/adr/0019): the carry is applied as a whole,
    // so the balances listed add up to 0 whatever the read sees of a leave that lands meanwhile.
    const passed = await this.groupMembers.passedBalancesOf(groupId);
    if (passed) carryPassed(balances, passed);
    return [...balances].map(([memberId, balance]): BalanceView => ({ memberId, balance }));
  }

  async groupIds(): Promise<string[]> {
    return this.database.exclusive(() =>
      (
        this.database.connection.prepare('SELECT DISTINCT group_id FROM expenses').all() as Array<{ group_id: string }>
      ).map(row => String(row.group_id)),
    );
  }

  async expensesOf(groupId: string): Promise<ExpenseView[]> {
    // The rowid is the order of recording: an edit updates the row in place, so it keeps the rowid it was inserted with (docs/adr/0008).
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const rows = connection
        .prepare(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE group_id = ? ORDER BY date DESC, rowid DESC`)
        .all(groupId) as ExpenseRow[];
      const shares = connection
        .prepare(
          'SELECT s.expense_id, s.member_id, s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ? ORDER BY s.expense_id, s.position',
        )
        .all(groupId) as GroupShareRow[];
      const sharesByExpense = new Map<string, ShareRow[]>();
      for (const share of shares) {
        const list = sharesByExpense.get(share.expense_id) ?? [];
        list.push(share);
        sharesByExpense.set(share.expense_id, list);
      }
      return rows.map(row => expenseView(row, sharesByExpense.get(row.id) ?? []));
    });
  }

  async statementOf(groupId: string, memberId: string): Promise<StatementEntryView[]> {
    // One statement, so one snapshot: the member's entries and their running balance, in a bank statement's order (docs/adr/0008).
    // The running balance is a window sum over what the member paid less their share; the rowid breaks a tie in the date.
    return this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(
          `SELECT expense_id, date, description, paid, share,
               SUM(paid - share) OVER (ORDER BY date, rid) AS balance
             FROM (
               SELECT e.rowid AS rid, e.id AS expense_id, e.date AS date, e.description AS description,
                 CASE WHEN e.paid_by = ? THEN e.amount ELSE 0 END AS paid,
                 COALESCE((SELECT s.amount FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = ?), 0) AS share
               FROM expenses e
               WHERE e.group_id = ?
                 AND (e.paid_by = ? OR EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = ?))
             )
             ORDER BY date, rid`,
        )
        .all(memberId, memberId, groupId, memberId, memberId) as StatementRow[];
      return rows.map((row): StatementEntryView => ({
        expenseId: String(row.expense_id),
        date: String(row.date),
        description: String(row.description),
        paid: Number(row.paid),
        share: Number(row.share),
        balance: Number(row.balance),
      }));
    });
  }
}

/**
 * What the members' leaves passed to the owner, applied to the balances (request 20, docs/adr/0019). A member who left, or joined again
 * after leaving, is counted from what it had when it left: its balance is less what passed, so one who joins again starts at 0. The owner
 * carries what passed. A former member who has not joined again is no longer listed, so what it still holds passes to the owner too, and
 * its own balance is taken off the list. Summed over the members, the balances stay 0.
 */
function carryPassed(balances: Map<string, number>, passed: PassedBalances): void {
  let carried = 0;
  for (const member of passed.members) {
    const balance = (balances.get(member.memberId) ?? 0) - member.passed;
    carried += member.passed;
    if (member.current) {
      balances.set(member.memberId, balance);
    } else {
      carried += balance;
      balances.delete(member.memberId);
    }
  }
  balances.set(passed.ownerId, (balances.get(passed.ownerId) ?? 0) + carried);
}

/** An expense's read model from its row and its shares, in the order of the split. */
function expenseView(row: ExpenseRow, shares: ShareRow[]): ExpenseView {
  const original = originalOfRow(row);
  return {
    ...(original ? { original } : {}),
    id: String(row.id),
    groupId: String(row.group_id),
    description: String(row.description),
    amount: Number(row.amount),
    date: String(row.date),
    paidBy: String(row.paid_by),
    splitKind: String(row.split_kind) as SplitKind,
    version: Number(row.version),
    shares: shares.map((share): ShareSnapshot => ({ memberId: String(share.member_id), amount: Number(share.amount) })),
  };
}
