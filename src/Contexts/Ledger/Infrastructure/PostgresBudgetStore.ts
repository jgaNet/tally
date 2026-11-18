import { ConcurrencyConflictException } from '@Architecture/Domain';
import { PostgresDatabase, isUniqueViolation } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { BudgetLine, IBudgetStore } from '@Contexts/Ledger/Application/IBudgetStore';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { CATEGORIES, Category } from '@Contexts/Ledger/Domain/Expense/Category';

const categoriesSql = CATEGORIES.map(category => `'${category}'`).join(', ');

/**
 * The budgets' tables (request 24, ADR 19). `budgets` is one row per group and category: its amount (null once removed), and the version it
 * is stored at, updated only while it is still at the version the aggregate was loaded at. `budget_passes` is one row per month a budget has
 * passed, kept when the budget is removed, so that a month's notice is made once. Created by `CREATE TABLE IF NOT EXISTS`, as every table here.
 */
export const budgetsTablesSchema = [
  `CREATE TABLE IF NOT EXISTS budgets (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL REFERENCES groups(id),
     category TEXT NOT NULL CHECK (category IN (${categoriesSql})),
     amount INTEGER,
     version INTEGER NOT NULL,
     UNIQUE (group_id, category)
   )`,
  `CREATE TABLE IF NOT EXISTS budget_passes (
     budget_id TEXT NOT NULL REFERENCES budgets(id),
     month TEXT NOT NULL,
     PRIMARY KEY (budget_id, month)
   )`,
];

interface BudgetRow {
  id: string;
  group_id: string;
  category: Category;
  amount: number | null;
  version: number;
}

/**
 * The budgets in PostgreSQL. `add` and `save` write inside the command's or the reaction's transaction, `save` only while the budget is still at
 * the version it was loaded at (the optimistic check, ADR 8). A budget added twice for one category is refused as a conflict, as a second
 * writer's save is.
 */
export class PostgresBudgetStore implements IBudgetStore {
  constructor(private readonly database: PostgresDatabase) {}

  async findByCategory(groupId: string, category: Category): Promise<Budget | undefined> {
    const row = (await this.database.writer
      .prepare('SELECT id, group_id, category, amount, version FROM budgets WHERE group_id = ? AND category = ?')
      .get(groupId, category)) as unknown as BudgetRow | undefined;
    if (!row) return undefined;
    const passes = (await this.database.writer
      .prepare('SELECT month FROM budget_passes WHERE budget_id = ? ORDER BY month')
      .all(row.id)) as unknown as { month: string }[];
    return Budget.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      category: row.category,
      amount: row.amount ?? undefined,
      passedMonths: passes.map(pass => pass.month),
      version: row.version,
    });
  }

  async add(budget: Budget): Promise<void> {
    const snapshot = budget.toSnapshot();
    try {
      await this.database.writer
        .prepare('INSERT INTO budgets (id, group_id, category, amount, version) VALUES (?, ?, ?, ?, ?)')
        .run(snapshot.id, snapshot.groupId, snapshot.category, snapshot.amount ?? null, snapshot.version + 1);
    } catch (error) {
      if (error instanceof Error && isUniqueViolation(error)) {
        throw new ConcurrencyConflictException('Ledger', 'The budget changed since it was read: read it again');
      }
      throw error;
    }
    await this.#writePasses(snapshot.id, snapshot.passedMonths);
  }

  async save(budget: Budget): Promise<void> {
    const snapshot = budget.toSnapshot();
    const { changes } = await this.database.writer
      .prepare('UPDATE budgets SET amount = ?, version = ? WHERE id = ? AND version = ?')
      .run(snapshot.amount ?? null, snapshot.version + 1, snapshot.id, snapshot.version);
    if (changes === 0) {
      throw new ConcurrencyConflictException('Ledger', 'The budget changed since it was read: read it again');
    }
    await this.#writePasses(snapshot.id, snapshot.passedMonths);
  }

  async linesOf(groupId: string): Promise<BudgetLine[]> {
    const rows = (await this.database.read(db =>
      db.prepare('SELECT category, amount FROM budgets WHERE group_id = ? AND amount IS NOT NULL').all(groupId),
    )) as unknown as { category: Category; amount: number }[];
    return rows.map(row => ({ category: row.category, amount: row.amount }));
  }

  /** Keeps every month the budget has passed; a month kept already is left as it is. */
  async #writePasses(budgetId: string, months: readonly string[]): Promise<void> {
    for (const month of months) {
      await this.database.writer
        .prepare('INSERT INTO budget_passes (budget_id, month) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(budgetId, month);
    }
  }
}
