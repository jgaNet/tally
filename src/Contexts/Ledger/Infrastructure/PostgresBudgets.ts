import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { BudgetSnapshot } from '@Contexts/Ledger/Domain/Budget/DTOs';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgets } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgets';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * The budgets' table (request 24, docs/adr/0023): one row per group and category, the amount it is set to (NULL once it is removed),
 * and the months it was passed in, as JSON. The row is kept when the budget is removed, so the months are never notified again.
 */
export const BUDGET_SCHEMA =
  "CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, category TEXT NOT NULL, amount INTEGER, passed_months TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL, UNIQUE (group_id, category))";

/** A budget's row, as the store reads it. */
export type BudgetRow = {
  id: string;
  group_id: string;
  category: string;
  amount: number | null;
  passed_months: string;
  version: number;
};

/** The columns a budget row is read by, in the order `BudgetRow` lists them. */
export const BUDGET_COLUMNS = 'id, group_id, category, amount, passed_months, version';

/** The snapshot a row keeps: the aggregate is read back from it, and checks what it is given. */
export function budgetSnapshotOf(row: BudgetRow): BudgetSnapshot {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    category: String(row.category) as Category,
    ...(row.amount === null ? {} : { amount: Number(row.amount) }),
    passedMonths: JSON.parse(String(row.passed_months)) as string[],
    version: Number(row.version),
  };
}

/**
 * The budgets' store over PostgreSQL. Its methods run inside a transaction: the use case's or the reaction's. A save of a budget read at a
 * version another writer has moved past changes nothing and answers a conflict (CONC-OPTIMISTIC).
 */
export class PostgresBudgets implements IBudgets {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareBudgetSchema);
  }

  async get(groupId: string, category: Category): Promise<Budget | undefined> {
    this.database.assertInTransaction();
    const row = await this.database.get<BudgetRow>(
      `SELECT ${BUDGET_COLUMNS} FROM budgets WHERE group_id = ? AND category = ?`,
      [groupId, category],
    );
    return row ? Budget.fromSnapshot(budgetSnapshotOf(row)) : undefined;
  }

  async save(budget: Budget): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = budget.toSnapshot();
    const amount = snapshot.amount ?? null;
    const passed = JSON.stringify(snapshot.passedMonths);
    if (snapshot.version === 0) {
      await this.database.run(`INSERT INTO budgets (${BUDGET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, [
        snapshot.id,
        snapshot.groupId,
        snapshot.category,
        amount,
        passed,
        snapshot.version + 1,
      ]);
      return Result.ok(undefined);
    }
    const { changes } = await this.database.run(
      'UPDATE budgets SET amount = ?, passed_months = ?, version = ? WHERE id = ? AND version = ?',
      [amount, passed, snapshot.version + 1, snapshot.id, snapshot.version],
    );
    if (changes === 0) return Result.fail(changedSinceRead());
    return Result.ok(undefined);
  }
}

/** Makes the budgets' table what the store reads: created once, when the database is prepared. */
export async function prepareBudgetSchema(database: PostgresDatabase): Promise<void> {
  await database.exec(BUDGET_SCHEMA);
}

const changedSinceRead = () => new ConcurrencyConflictException('Ledger', 'The budget changed since it was read');
