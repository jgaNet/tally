import { DatabaseSync } from 'node:sqlite';

import { prepareLedgerSchema } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';

describe('prepareLedgerSchema', () => {
  it('makes a file kept before the split kinds read every expense it holds as split equally', () => {
    const connection = new DatabaseSync(':memory:');
    connection.exec(
      'CREATE TABLE expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL, paid_by TEXT NOT NULL, version INTEGER NOT NULL)',
    );
    connection.exec("INSERT INTO expenses VALUES ('e1', 'g1', 'Rent', 10, '2026-01-15', 'ada', 1)");

    prepareLedgerSchema(connection);

    expect(connection.prepare("SELECT split_kind FROM expenses WHERE id = 'e1'").get()).toEqual({
      split_kind: 'equal',
    });
  });

  it('leaves a file that already has the column as it is, and can be prepared again', () => {
    const connection = new DatabaseSync(':memory:');
    prepareLedgerSchema(connection);
    connection.exec(
      "INSERT INTO expenses (id, group_id, description, amount, date, paid_by, split_kind, version) VALUES ('e2', 'g1', 'Cottage', 10, '2026-01-15', 'ada', 'shares', 1)",
    );

    prepareLedgerSchema(connection);

    expect(connection.prepare("SELECT split_kind FROM expenses WHERE id = 'e2'").get()).toEqual({
      split_kind: 'shares',
    });
  });
});
