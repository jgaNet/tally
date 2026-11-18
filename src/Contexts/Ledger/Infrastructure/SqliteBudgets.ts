import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';
import { IBudgetQueries } from '@Contexts/Ledger/Application/IBudgetQueries';
import { IBudgetRepository } from '@Contexts/Ledger/Application/IBudgetRepository';

import { LedgerDatabase } from './LedgerDatabase';

type BudgetRow = { id: string; group_id: string; category: ExpenseCategory; amount: number | null; version: number };

/**
 * The budgets in SQLite (request 24): the repository the budget use cases and the policy on an expense load and write, and the read side
 * `GetGroupBudgets` reads. A budget and the months it was passed in are written in one transaction; a save is conditional on the version
 * it was read at (CONC-OPTIMISTIC), the check and the write one transaction on the file, so of two writers from one version the second
 * is refused and keeps nothing of its change.
 */
export class SqliteBudgets implements IBudgetRepository, IBudgetQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async get(groupId: string, category: ExpenseCategory): Promise<Budget | undefined> {
    const connection = this.database.connection;
    const row = connection
      .prepare('SELECT id, group_id, category, amount, version FROM ledger_budgets WHERE group_id = ? AND category = ?')
      .get(groupId, category) as BudgetRow | undefined;
    if (!row) return undefined;
    const months = connection
      .prepare('SELECT month FROM ledger_budget_passed_months WHERE budget_id = ? ORDER BY month')
      .all(row.id) as { month: string }[];
    return Budget.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      category: row.category,
      amount: row.amount ?? undefined,
      passedMonths: months.map(({ month }) => month),
      version: row.version,
    });
  }

  async insert(budget: Budget): Promise<void> {
    const { id, groupId, category, amount, passedMonths, version } = budget.toSnapshot();
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      connection
        .prepare('INSERT INTO ledger_budgets (id, group_id, category, amount, version) VALUES (?, ?, ?, ?, ?)')
        .run(id, groupId, category, amount ?? null, version + 1);
      this.#writeMonths(id, passedMonths);
    });
  }

  async save(budget: Budget): Promise<void> {
    const { id, amount, passedMonths, version } = budget.toSnapshot();
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      const stored = connection.prepare('SELECT version FROM ledger_budgets WHERE id = ?').get(id) as
        { version: number } | undefined;
      if (!stored || stored.version !== version) {
        throw new ConcurrencyConflictException('Ledger', 'The budget changed since it was read');
      }
      connection
        .prepare('UPDATE ledger_budgets SET amount = ?, version = ? WHERE id = ?')
        .run(amount ?? null, version + 1, id);
      this.#writeMonths(id, passedMonths);
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.file.transaction(work);
  }

  async budgetsOf(groupId: string): Promise<{ category: ExpenseCategory; amount: number }[]> {
    const rows = this.database.connection
      .prepare('SELECT category, amount FROM ledger_budgets WHERE group_id = ? AND amount IS NOT NULL')
      .all(groupId) as { category: ExpenseCategory; amount: number }[];
    return rows.map(({ category, amount }) => ({ category, amount }));
  }

  #writeMonths(budgetId: string, months: readonly string[]): void {
    const insert = this.database.connection.prepare(
      'INSERT OR IGNORE INTO ledger_budget_passed_months (budget_id, month) VALUES (?, ?)',
    );
    for (const month of months) insert.run(budgetId, month);
  }
}
