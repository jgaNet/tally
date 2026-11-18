import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { BUDGET_STATEMENTS } from '@Contexts/Ledger/Infrastructure/budgets.schema';

interface BudgetRow {
  id: string;
  group_id: string;
  category: Category;
  amount: number;
  active: number;
  passed_months: string;
  version: number;
}

/** The budgets' repository over the PostgreSQL database; used inside the command's or the reaction's transaction, which holds the connection. */
export class PostgresBudgetRepository implements IBudgetRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(BUDGET_STATEMENTS);
  }

  async findByCategory(groupId: Id, category: Category): Promise<Budget | null> {
    const row = await this.database.connection.row<BudgetRow>(
      'SELECT * FROM ledger_budgets WHERE group_id = ? AND category = ?',
      groupId.value,
      category,
    );
    if (!row) return null;
    return Budget.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      category: row.category,
      amount: row.amount,
      active: row.active === 1,
      passedMonths: JSON.parse(row.passed_months) as string[],
      version: row.version,
    });
  }

  async save(budget: Budget): Promise<IResult> {
    const { id, groupId, category, amount, active, passedMonths, version } = budget.toSnapshot();
    const { connection } = this.database;
    const conflict = () =>
      Result.fail(new ConcurrencyConflictException('Ledger', 'The budget changed since it was read', { id }));
    if (version === 0) {
      // Nothing inserted: the category of the group has its budget already, another set of it was saved first. The
      // conflict is not a failed statement, which would abort the whole transaction in PostgreSQL.
      const { changes } = await connection.run(
        `INSERT INTO ledger_budgets (id, group_id, category, amount, active, passed_months, version)
         VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`,
        id,
        groupId,
        category,
        amount,
        active ? 1 : 0,
        JSON.stringify(passedMonths),
      );
      return changes === 0 ? conflict() : Result.ok();
    }
    const { changes } = await connection.run(
      `UPDATE ledger_budgets SET amount = ?, active = ?, passed_months = ?, version = version + 1
        WHERE id = ? AND version = ?`,
      amount,
      active ? 1 : 0,
      JSON.stringify(passedMonths),
      id,
      version,
    );
    return changes === 0 ? conflict() : Result.ok();
  }
}
