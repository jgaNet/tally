import { Id } from '@Architecture/Domain';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/database.spec-helper';
import { PostgresExpenseRepository } from '@Contexts/Ledger/Infrastructure/PostgresExpenseRepository';

describe('PostgresExpenseRepository over a database written before splits had kinds', () => {
  it('reads an expense recorded before as split equally, and keeps the rows it has', async () => {
    const database = freshDatabase();
    // The tables as request 4 and 6 left them: no ledger_expense_splits.
    await database.exclusive(async connection => {
      await connection.run(`
        CREATE TABLE ledger_expenses (
          id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount BIGINT NOT NULL,
          date TEXT NOT NULL, paid_by TEXT NOT NULL, recorded_at TEXT NOT NULL, version BIGINT NOT NULL
        )`);
      await connection.run(`
        CREATE TABLE ledger_expense_shares (
          expense_id TEXT NOT NULL, position BIGINT NOT NULL, member_id TEXT NOT NULL, amount BIGINT NOT NULL,
          PRIMARY KEY (expense_id, position)
        )`);
      await connection.run(
        `INSERT INTO ledger_expenses VALUES ('old', 'group', 'Groceries', 10, '2026-05-10', 'alice', '2026-05-10T12:00:00.000Z', 1)`,
      );
      await connection.run(`INSERT INTO ledger_expense_shares VALUES ('old', 0, 'bob', 6), ('old', 1, 'alice', 4)`);
    });

    const repository = new PostgresExpenseRepository(database);
    const unit = new PostgresUnitOfWork(database);
    await unit.beginTransaction();
    const expense = await repository.findById(new Id('old'));

    expect(expense?.split.kind).toBe('equal');
    expect(expense?.toSnapshot()).toMatchObject({
      splitKind: 'equal',
      paidBy: 'alice',
      shares: [
        { memberId: 'bob', amount: 6 },
        { memberId: 'alice', amount: 4 },
      ],
    });
    await unit.rollbackTransaction();
    await database.close();
  });
});
