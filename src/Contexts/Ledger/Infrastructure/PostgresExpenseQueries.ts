import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import {
  BalanceView,
  ExpenseView,
  ShareSnapshot,
  SplitKind,
  StatementEntryView,
} from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseQueries } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseQueries';
import { memberStatementEntries, StatementExpense } from '@Contexts/Ledger/Domain/Expense/Statement';
import { IGroupMembers, PassedBalances } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { ISettledAmounts } from '@Contexts/Ledger/Domain/Expense/Ports/ISettledAmounts';
import {
  EXPENSE_COLUMNS,
  ExpenseRow,
  originalOfRow,
  prepareLedgerSchema,
} from '@Contexts/Ledger/Infrastructure/PostgresExpenseRepository';
import { DEFAULT_CATEGORY, Category } from '@Contexts/Ledger/Domain/Expense/Category';

type ShareRow = { member_id: string; amount: number };
type GroupShareRow = ShareRow & { expense_id: string };
type BalanceRow = { member_id: string; balance: number };
type StatementRow = {
  expense_id: string;
  date: string;
  description: string;
  recorded_at: string;
  paid: number;
  share: number;
};

/** The read side of the expenses over PostgreSQL: reads taken alone, outside any transaction (docs/adr/0004). */
export class PostgresExpenseQueries implements IExpenseQueries {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly settled: ISettledAmounts,
    private readonly groupMembers: IGroupMembers,
  ) {
    database.prepare(prepareLedgerSchema);
  }

  async findExpense(expenseId: string): Promise<ExpenseView | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<ExpenseRow>(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = ?`, [
        expenseId,
      ]);
      if (!row) return undefined;
      const shares = await this.database.all<ShareRow>(
        'SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position',
        [expenseId],
      );
      return expenseView(row, shares);
    });
  }

  async balancesOf(groupId: string): Promise<BalanceView[]> {
    // What is settled is read first, outside the database's turn: a settlement is Settlements' rows, read on its own connection.
    // The expenses are one statement, so one snapshot: what a member paid, less their shares, over the group's expenses (docs/adr/0005).
    // Each member's balance then moves by what they settled (docs/adr/0013): a settlement paid moves the payer's balance up by its amount.
    const settled = await this.settled.settledOf(groupId);
    const expenses = await this.database.exclusive(async () => {
      const rows = await this.database.all<BalanceRow>(
        `SELECT member_id, SUM(amount) AS balance FROM (
           SELECT paid_by AS member_id, amount FROM expenses WHERE group_id = ?
           UNION ALL
           SELECT s.member_id, -s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?
         ) balances GROUP BY member_id`,
        [groupId, groupId],
      );
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
    return this.database.exclusive(async () =>
      (await this.database.all<{ group_id: string }>('SELECT DISTINCT group_id FROM expenses')).map(row =>
        String(row.group_id),
      ),
    );
  }

  async expensesOf(groupId: string): Promise<ExpenseView[]> {
    // The seq is the order of recording: an edit updates the row in place, so it keeps the seq it was inserted with (docs/adr/0008).
    return this.database.exclusive(async () => {
      const rows = await this.database.all<ExpenseRow>(
        `SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE group_id = ? ORDER BY date COLLATE "C" DESC, seq DESC`,
        [groupId],
      );
      const shares = await this.database.all<GroupShareRow>(
        'SELECT s.expense_id, s.member_id, s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ? ORDER BY s.expense_id, s.position',
        [groupId],
      );
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
    // The settlements that count are read first, outside the database's turn, as balancesOf reads them: they are Settlements' rows, read on
    // their own connection. Then the member's expenses in one statement, in the order they fall in the statement: the date, then the
    // moment recorded, then the seq. The lines are merged and their running balance computed in the domain (docs/adr/0028).
    const counted = await this.settled.countedOf(groupId);
    const expenses = await this.database.exclusive(async () =>
      (
        await this.database.all<StatementRow>(
          `SELECT e.id AS expense_id, e.date, e.description, e.recorded_at,
               CASE WHEN e.paid_by = ? THEN e.amount ELSE 0 END AS paid,
               COALESCE((SELECT s.amount FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = ?), 0) AS share
             FROM expenses e
             WHERE e.group_id = ?
               AND (e.paid_by = ? OR EXISTS (SELECT 1 FROM expense_shares s WHERE s.expense_id = e.id AND s.member_id = ?))
             ORDER BY e.date COLLATE "C", e.recorded_at COLLATE "C", e.seq`,
          [memberId, memberId, groupId, memberId, memberId],
        )
      ).map((row): StatementExpense => ({
        expenseId: String(row.expense_id),
        date: String(row.date),
        description: String(row.description),
        recordedAt: String(row.recorded_at),
        paid: Number(row.paid),
        share: Number(row.share),
      })),
    );
    return memberStatementEntries(memberId, expenses, counted);
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
    category: String(row.category || DEFAULT_CATEGORY) as Category,
    version: Number(row.version),
    shares: shares.map((share): ShareSnapshot => ({ memberId: String(share.member_id), amount: Number(share.amount) })),
  };
}
