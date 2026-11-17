import { Id } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';

describe('SqliteExpenseRepository over a file written before splits had kinds', () => {
  it('reads an expense recorded before as split equally, and keeps the rows it has', async () => {
    const database = new SqliteDatabase(':memory:');
    // The tables as request 4 and 6 left them: no ledger_expense_splits.
    database.connection.exec(`
      CREATE TABLE ledger_expenses (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL,
        date TEXT NOT NULL, paid_by TEXT NOT NULL, recorded_at TEXT NOT NULL, version INTEGER NOT NULL
      );
      CREATE TABLE ledger_expense_shares (
        expense_id TEXT NOT NULL, position INTEGER NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL,
        PRIMARY KEY (expense_id, position)
      );
      INSERT INTO ledger_expenses VALUES ('old', 'group', 'Groceries', 10, '2026-05-10', 'alice', '2026-05-10T12:00:00.000Z', 1);
      INSERT INTO ledger_expense_shares VALUES ('old', 0, 'bob', 6), ('old', 1, 'alice', 4);
    `);

    const repository = new SqliteExpenseRepository(database);
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
    database.close();
  });
});
