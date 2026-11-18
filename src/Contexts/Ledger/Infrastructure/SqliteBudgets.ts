import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { ExpenseCategory } from '@Contexts/Ledger/Domain/Expense/ExpenseCategory';
import { IBudgetQueries } from '@Contexts/Ledger/Application/IBudgetQueries';
import { IBudgetRepository } from '@Contexts/Ledger/Application/IBudgetRepository';

import { LedgerDatabase } from './LedgerDatabase';

type BudgetRow = { id: string; group_id: string; category: ExpenseCategory; amount: number | null; version: number };

/**
 * The budgets in PostgreSQL (request 24): the repository the budget use cases and the policy on an expense load and write, and the read side
 * `GetGroupBudgets` reads. A budget and the months it was passed in are written in one transaction; a save is conditional on the version
 * it was read at (CONC-OPTIMISTIC), the check and the write one transaction, so of two writers from one version the second is refused and
 * keeps nothing of its change.
 */
export class SqliteBudgets implements IBudgetRepository, IBudgetQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async get(groupId: string, category: ExpenseCategory): Promise<Budget | undefined> {
    const row = await this.database.row<BudgetRow>(
      'SELECT id, group_id, category, amount, version FROM ledger_budgets WHERE group_id = $1 AND category = $2',
      [groupId, category],
    );
    if (!row) return undefined;
    const months = await this.database.rows<{ month: string }>(
      'SELECT month FROM ledger_budget_passed_months WHERE budget_id = $1 ORDER BY month',
      [row.id],
    );
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
    await this.database.transaction(async () => {
      await this.database.execute(
        'INSERT INTO ledger_budgets (id, group_id, category, amount, version) VALUES ($1, $2, $3, $4, $5)',
        [id, groupId, category, amount ?? null, version + 1],
      );
      await this.#writeMonths(id, passedMonths);
    });
  }

  async save(budget: Budget): Promise<void> {
    const { id, amount, passedMonths, version } = budget.toSnapshot();
    await this.database.transaction(async () => {
      const stored = await this.database.row<{ version: number }>('SELECT version FROM ledger_budgets WHERE id = $1', [
        id,
      ]);
      if (!stored || stored.version !== version) {
        throw new ConcurrencyConflictException('Ledger', 'The budget changed since it was read');
      }
      await this.database.execute('UPDATE ledger_budgets SET amount = $1, version = $2 WHERE id = $3', [
        amount ?? null,
        version + 1,
        id,
      ]);
      await this.#writeMonths(id, passedMonths);
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async budgetsOf(groupId: string): Promise<{ category: ExpenseCategory; amount: number }[]> {
    const rows = await this.database.rows<{ category: ExpenseCategory; amount: number }>(
      'SELECT category, amount FROM ledger_budgets WHERE group_id = $1 AND amount IS NOT NULL',
      [groupId],
    );
    return rows.map(({ category, amount }) => ({ category, amount }));
  }

  async #writeMonths(budgetId: string, months: readonly string[]): Promise<void> {
    for (const month of months) {
      await this.database.execute(
        'INSERT INTO ledger_budget_passed_months (budget_id, month) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [budgetId, month],
      );
    }
  }
}
