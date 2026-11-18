import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException } from '@Architecture/Domain';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { decideEditExpense, decideRecordExpense } from '@Contexts/Ledger/Domain/Expense/Expense.decision';

import { LedgerDatabase } from './LedgerDatabase';
import { SqliteExpenses } from './SqliteExpenses';

const now = new Date('2026-11-17T10:00:00Z');
const ada = '3c9d2f1e-0000-4000-8000-000000000001';
const grace = '3c9d2f1e-0000-4000-8000-000000000002';
const linus = '3c9d2f1e-0000-4000-8000-000000000003';
const groupId = '3c9d2f1e-0000-4000-8000-0000000000aa';

const newDatabasePath = () => join(mkdtempSync(join(tmpdir(), 'tally-ledger-store-')), 'tally.sqlite');

/** A recorded expense of 1000 paid by Ada, split between the three, as Ledger stores it. */
function recorded(): Expense {
  const decision = decideRecordExpense(
    { memberIds: [ada, grace, linus], groupCurrency: 'EUR' },
    {
      description: 'Groceries',
      amount: 1000,
      date: '2026-11-16',
      split: { kind: 'equal', memberIds: [ada, grace, linus] },
      payer: ada,
    },
    now,
  );
  return Expense.register({ groupId, ...decision.data!.state });
}

/**
 * The balances of the group that are not 0 (a member at 0 reads as 0, as a member the group has no row for does): they must
 * add up to 0 whatever has been recorded, edited or deleted.
 */
const balancesOf = async (store: SqliteExpenses) =>
  Object.fromEntries([...(await store.balancesOf(groupId))].filter(([, balance]) => balance !== 0));

describe('saving an expense over a newer version of it (CONC-OPTIMISTIC, feature 6)', () => {
  it('refuses the second of two edits made from one version, and keeps only the first', async () => {
    // Two servers, two connections to one database file: each reads the expense at version 1.
    const path = newDatabasePath();
    const firstServer = new SqliteExpenses(new LedgerDatabase(() => path));
    const secondServer = new SqliteExpenses(new LedgerDatabase(() => path));

    const expense = recorded();
    await firstServer.insert(expense);
    const id = expense._id.value;

    const firstEdit = (await firstServer.get(id))!;
    const secondEdit = (await secondServer.get(id))!;
    expect(firstEdit.version).toBe(1);
    expect(secondEdit.version).toBe(1);

    const givenTo = (edited: Expense, amount: number) =>
      decideEditExpense(
        {
          expense: edited.toSnapshot(),
          memberIds: [ada, grace, linus],
          ownerId: ada,
          groupCurrency: 'EUR',
        },
        {
          by: ada,
          description: 'Groceries',
          amount,
          date: '2026-11-16',
          split: { kind: 'equal', memberIds: [ada, grace, linus] },
          version: 1,
        },
        now,
      ).data!.state;

    firstEdit.revise(givenTo(firstEdit, 1200));
    await firstServer.save(firstEdit);
    expect((await firstServer.expenseOf(id))!.version).toBe(2);

    secondEdit.revise(givenTo(secondEdit, 300));
    await expect(secondServer.save(secondEdit)).rejects.toBeInstanceOf(ConcurrencyConflictException);

    // Nothing of the refused edit is kept: the first edit stands, and the balances add up to 0.
    const stored = (await secondServer.expenseOf(id))!;
    expect(stored).toMatchObject({ amount: 1200, version: 2 });
    expect(stored.shares.reduce((sum, share) => sum + share.amount, 0)).toBe(1200);
    const balances = await balancesOf(secondServer);
    expect(Object.values(balances).reduce((sum, balance) => sum + balance, 0)).toBe(0);
    expect(balances).toEqual({ [ada]: 1200 - 400, [grace]: -400, [linus]: -400 });
  });
});

describe('moving the balances with an expense (feature 5, feature 6)', () => {
  it('takes an edited expense out of the balances it counted, and puts it back in as it now stands', async () => {
    const store = new SqliteExpenses(new LedgerDatabase(newDatabasePath));
    const expense = recorded();
    await store.insert(expense);
    const edited = (await store.get(expense._id.value))!;
    const decision = decideEditExpense(
      { expense: edited.toSnapshot(), memberIds: [ada, grace, linus], ownerId: ada, groupCurrency: 'EUR' },
      {
        by: ada,
        description: 'Groceries',
        amount: 300,
        date: '2026-11-16',
        split: { kind: 'equal', memberIds: [grace, ada] },
        version: 1,
      },
      now,
    );
    edited.revise(decision.data!.state);
    await store.save(edited);

    expect(await balancesOf(store)).toEqual({ [ada]: 150, [grace]: -150 });
  });

  it('takes a deleted expense out of every balance, and the expense out of every read', async () => {
    const store = new SqliteExpenses(new LedgerDatabase(newDatabasePath));
    const expense = recorded();
    await store.insert(expense);
    const stored = (await store.get(expense._id.value))!;
    stored.delete();
    await store.remove(stored);

    expect(await store.expenseOf(expense._id.value)).toBeUndefined();
    expect(await store.get(expense._id.value)).toBeUndefined();
    expect(await balancesOf(store)).toEqual({});
  });

  it('refuses to remove an expense another writer changed since it was read', async () => {
    const path = newDatabasePath();
    const store = new SqliteExpenses(new LedgerDatabase(() => path));
    const expense = recorded();
    await store.insert(expense);
    const readForDelete = (await store.get(expense._id.value))!;
    const readForEdit = (await store.get(expense._id.value))!;

    readForEdit.revise(
      decideEditExpense(
        { expense: readForEdit.toSnapshot(), memberIds: [ada, grace, linus], ownerId: ada, groupCurrency: 'EUR' },
        {
          by: ada,
          description: 'Groceries',
          amount: 600,
          date: '2026-11-16',
          split: { kind: 'equal', memberIds: [ada, grace, linus] },
          version: 1,
        },
        now,
      ).data!.state,
    );
    await store.save(readForEdit);

    readForDelete.delete();
    await expect(store.remove(readForDelete)).rejects.toBeInstanceOf(ConcurrencyConflictException);
    expect((await store.expenseOf(expense._id.value))!.amount).toBe(600);
  });
});

describe('a database written by feature 4 or 5', () => {
  it('is brought up to the layout this feature needs: each expense at version 1, and its balances as they were', async () => {
    const path = newDatabasePath();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE ledger_expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL, paid_by TEXT NOT NULL);
      CREATE TABLE ledger_expense_shares (expense_id TEXT NOT NULL REFERENCES ledger_expenses (id), position INTEGER NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (expense_id, position));
      INSERT INTO ledger_expenses VALUES ('6f1d2c3b-0000-4000-8000-0000000000ee', '${groupId}', 'Old', 900, '2026-11-01', '${ada}');
      INSERT INTO ledger_expense_shares VALUES ('6f1d2c3b-0000-4000-8000-0000000000ee', 0, '${ada}', 300);
      INSERT INTO ledger_expense_shares VALUES ('6f1d2c3b-0000-4000-8000-0000000000ee', 1, '${grace}', 300);
      INSERT INTO ledger_expense_shares VALUES ('6f1d2c3b-0000-4000-8000-0000000000ee', 2, '${linus}', 300);
    `);
    old.close();

    const store = new SqliteExpenses(new LedgerDatabase(() => path));
    expect(await store.expenseOf('6f1d2c3b-0000-4000-8000-0000000000ee')).toMatchObject({ version: 1, amount: 900 });
    expect(await balancesOf(store)).toEqual({ [ada]: 600, [grace]: -300, [linus]: -300 });
  });
});
