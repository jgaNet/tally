import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ShareSnapshot, SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';

/**
 * The ledger's tables: an expense is a row, and its shares are rows of their own, keyed by the expense and the position
 * in the split, so the order the split was given is kept.
 */
export const LEDGER_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL, paid_by TEXT NOT NULL, split_kind TEXT NOT NULL DEFAULT 'equal', version INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS expense_shares (expense_id TEXT NOT NULL REFERENCES expenses (id), position INTEGER NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (expense_id, position))',
].join(';\n');

/**
 * Makes the ledger's tables what the stores read, on a file that may have been made before the split kinds (request 7): there,
 * every expense was split equally, which is the default the column takes.
 */
export function prepareLedgerSchema(connection: DatabaseSync): void {
  connection.exec(LEDGER_SCHEMA);
  const columns = connection.prepare('PRAGMA table_info(expenses)').all() as Array<{ name: string }>;
  if (columns.some(column => column.name === 'split_kind')) return;
  connection.exec("ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'");
}

type ExpenseRow = {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  split_kind: string;
  version: number;
};
type ShareRow = { member_id: string; amount: number };

/**
 * The expenses' store over SQLite (docs/adr/0004, docs/adr/0006). Its methods run inside a transaction: the use case's.
 * A save or a removal of an expense read at a version another writer has moved past changes nothing and answers a
 * conflict, so the use case re-reads and re-decides (CONC-OPTIMISTIC).
 */
export class SqliteExpenseRepository implements IExpenseRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareLedgerSchema);
  }

  async get(expenseId: string): Promise<Expense | undefined> {
    this.database.assertInTransaction();
    const connection = this.database.connection;
    const row = connection
      .prepare(
        'SELECT id, group_id, description, amount, date, paid_by, split_kind, version FROM expenses WHERE id = ?',
      )
      .get(expenseId) as ExpenseRow | undefined;
    if (!row) return undefined;
    const shares = connection
      .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
      .all(expenseId) as ShareRow[];
    return Expense.fromSnapshot({
      id: String(row.id),
      groupId: String(row.group_id),
      description: String(row.description),
      amount: Number(row.amount),
      date: String(row.date),
      paidBy: String(row.paid_by),
      splitKind: String(row.split_kind) as SplitKind,
      shares: shares.map((share): ShareSnapshot => ({
        memberId: String(share.member_id),
        amount: Number(share.amount),
      })),
      version: Number(row.version),
    });
  }

  async save(expense: Expense): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = expense.toSnapshot();
    const connection = this.database.connection;
    if (snapshot.version === 0) {
      connection
        .prepare(
          'INSERT INTO expenses (id, group_id, description, amount, date, paid_by, split_kind, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          snapshot.id,
          snapshot.groupId,
          snapshot.description,
          snapshot.amount,
          snapshot.date,
          snapshot.paidBy,
          snapshot.splitKind,
          snapshot.version + 1,
        );
    } else {
      const { changes } = connection
        .prepare(
          'UPDATE expenses SET description = ?, amount = ?, date = ?, split_kind = ?, version = ? WHERE id = ? AND version = ?',
        )
        .run(
          snapshot.description,
          snapshot.amount,
          snapshot.date,
          snapshot.splitKind,
          snapshot.version + 1,
          snapshot.id,
          snapshot.version,
        );
      if (changes === 0) return Result.fail(changedSinceRead());
      connection.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(snapshot.id);
    }
    const insertShare = connection.prepare(
      'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
    );
    snapshot.shares.forEach((share, position) => {
      insertShare.run(snapshot.id, position, share.memberId, share.amount);
    });
    return Result.ok(undefined);
  }

  async remove(expense: Expense): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = expense.toSnapshot();
    const connection = this.database.connection;
    // The shares go first: they reference the expense (foreign keys are on). A conflict rolls the whole transaction back.
    connection.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(snapshot.id);
    const { changes } = connection
      .prepare('DELETE FROM expenses WHERE id = ? AND version = ?')
      .run(snapshot.id, snapshot.version);
    if (changes === 0) return Result.fail(changedSinceRead());
    return Result.ok(undefined);
  }
}

const changedSinceRead = () => new ConcurrencyConflictException('Ledger', 'The expense changed since it was read');
