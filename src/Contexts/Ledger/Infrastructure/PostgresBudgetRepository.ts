import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Budget } from '@Contexts/Ledger/Domain/Budget/Budget';
import { IBudgetRepository } from '@Contexts/Ledger/Domain/Budget/Ports/IBudgetRepository';
import { CategoryName } from '@Contexts/Ledger/Domain/Expense/Category';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface Row {
  id: string;
  group_id: string;
  category: string;
  amount: number;
  removed: number;
  version: number;
}

/**
 * The budgets, in the application's file. It runs inside the command's or the reaction's transaction, which holds the file, so it
 * takes no lock of its own. A save that finds the budget at another version than it was read at is a conflict, and its transaction
 * is rolled back with it.
 */
export class PostgresBudgetRepository implements IBudgetRepository {
  constructor(private database: PostgresDatabase) {
    createLedgerTables(database);
  }

  async findByGroupAndCategory(groupId: Id, category: CategoryName): Promise<Budget | null> {
    const row = await this.database.get<Row>(
      'SELECT id, group_id, category, amount, removed, version FROM budgets WHERE group_id = ? AND category = ?',
      groupId.value,
      category,
    );
    if (!row) return null;
    const months = await this.database.all<{ month: string }>(
      'SELECT month FROM budget_passed_months WHERE budget_id = ? ORDER BY month',
      row.id,
    );
    return Budget.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      category: row.category,
      amount: row.amount,
      removed: row.removed === 1,
      passedMonths: months.map(each => each.month),
      version: row.version,
    });
  }

  async save(budget: Budget): Promise<IResult> {
    const { id, groupId, category, amount, removed, passedMonths, version } = budget.toSnapshot();
    if (version === 0) {
      await this.database.run(
        'INSERT INTO budgets (id, group_id, category, amount, removed, version) VALUES (?, ?, ?, ?, ?, 1)',
        id,
        groupId,
        category,
        amount,
        removed ? 1 : 0,
      );
    } else {
      const changed = await this.database.run(
        'UPDATE budgets SET amount = ?, removed = ?, version = ? WHERE id = ? AND version = ?',
        amount,
        removed ? 1 : 0,
        version + 1,
        id,
        version,
      );
      if (!changed) {
        return Result.fail(new ConcurrencyConflictException('Ledger', 'The budget has changed', { id }));
      }
    }
    for (const month of passedMonths) {
      await this.database.run(
        'INSERT INTO budget_passed_months (budget_id, month) VALUES (?, ?) ON CONFLICT DO NOTHING',
        id,
        month,
      );
    }
    return Result.ok();
  }

  /** A merged group's budgets go with it, with the months they were passed in (request 31). */
  async dropGroup(groupId: Id): Promise<void> {
    await this.database.run(
      'DELETE FROM budget_passed_months WHERE budget_id IN (SELECT id FROM budgets WHERE group_id = ?)',
      groupId.value,
    );
    await this.database.run('DELETE FROM budgets WHERE group_id = ?', groupId.value);
  }
}
