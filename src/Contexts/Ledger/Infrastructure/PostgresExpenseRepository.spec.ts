import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { PostgresExpenseQueries } from '@Contexts/Ledger/Infrastructure/PostgresExpenseQueries';
import { PostgresExpenseRepository } from '@Contexts/Ledger/Infrastructure/PostgresExpenseRepository';

/**
 * A database of its own for this suite: named in DATABASE_URL now, and created on the server DATABASE_URL names before the
 * suite's first use of it (the same as Bootstrap's freshDatabase helper, which an Infrastructure spec may not import).
 */
function useFreshDatabase(suite: string): Promise<void> {
  const base = new URL(process.env.DATABASE_URL ?? '');
  const admin = new URL(base.toString());
  admin.pathname = '/postgres';
  const name = `tally_${suite}_${randomUUID().replace(/-/g, '')}`;
  base.pathname = `/${name}`;
  process.env.DATABASE_URL = base.toString();
  return (async () => {
    const client = new pg.Client({ connectionString: admin.toString() });
    await client.connect();
    try {
      await client.query(`CREATE DATABASE "${name}"`);
    } finally {
      await client.end();
    }
  })();
}

const database = useFreshDatabase('ledger_expenses');
const expenses = new PostgresExpenseRepository(sharedDatabase);
const queries = new PostgresExpenseQueries(sharedDatabase, {} as never, {} as never);

beforeAll(async () => {
  await database;
  // The schema every store registered, run once on the fresh database (what prepareDatabase does for the application).
  await sharedDatabase.transaction(async () => {
    for (const setup of sharedDatabase.setups) await setup(sharedDatabase);
  });
});

afterAll(() => sharedDatabase.close());

/** Writes expenses of `groupId` with a two-way equal split, the way the store wrote them, in the order given. */
async function seed(groupId: string, rows: Array<{ id: string; date: string }>): Promise<void> {
  await sharedDatabase.transaction(async () => {
    for (const { id, date } of rows) {
      await sharedDatabase.run(
        "INSERT INTO expenses (id, group_id, description, amount, date, paid_by, split_kind, version, category, recorded_at) VALUES (?, ?, 'Rent', 10, ?, 'ada', 'equal', 1, 'other', '')",
        [id, groupId, date],
      );
      await sharedDatabase.run(
        'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, 0, ?, 5)',
        [id, 'ada'],
      );
      await sharedDatabase.run(
        'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, 1, ?, 5)',
        [id, 'bob'],
      );
    }
  });
}

describe('PostgresExpenseRepository', () => {
  it('reads an expense back with its shares in the order they were given, and removes it', async () => {
    await seed('group-read', [{ id: 'read-1', date: '2026-01-15' }]);

    const read = await sharedDatabase.transaction(() => expenses.get('read-1'));
    expect(read?.toSnapshot().shares).toEqual([
      { memberId: 'ada', amount: 5 },
      { memberId: 'bob', amount: 5 },
    ]);

    const removed = await sharedDatabase.transaction(async () => {
      const expense = await expenses.get('read-1');
      return expense && expenses.remove(expense);
    });
    expect(removed?.isSuccess()).toBe(true);
    expect(await sharedDatabase.transaction(() => expenses.get('read-1'))).toBeUndefined();
  });

  it('lists a group newest day first, and within a day in the order each expense was recorded', async () => {
    await seed('group-list', [
      { id: 'list-1', date: '2026-01-15' },
      { id: 'list-2', date: '2026-01-15' },
      { id: 'list-3', date: '2026-01-10' },
    ]);

    const listed = await queries.expensesOf('group-list');
    expect(listed.map(expense => expense.id)).toEqual(['list-2', 'list-1', 'list-3']);
  });
});
