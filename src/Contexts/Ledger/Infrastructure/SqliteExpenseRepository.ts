import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { OriginalAmountSnapshot, ShareSnapshot, SplitKind } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { Category, DEFAULT_CATEGORY } from '@Contexts/Ledger/Domain/Expense/Category';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { LEDGER_AUDIT_SCHEMA, recordAudit } from '@Contexts/Ledger/Infrastructure/SqliteAuditEntries';

/**
 * The ledger's tables: an expense is a row, and its shares are rows of their own, keyed by the expense and the position
 * in the split, so the order the split was given is kept.
 */
export const LEDGER_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL, paid_by TEXT NOT NULL, split_kind TEXT NOT NULL DEFAULT 'equal', version INTEGER NOT NULL)",
  'CREATE TABLE IF NOT EXISTS expense_shares (expense_id TEXT NOT NULL REFERENCES expenses (id), position INTEGER NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (expense_id, position))',
].join(';\n');

/**
 * What an expense was paid in, when not in the group's currency (request 21): three nullable columns, null for an expense in the
 * group's currency and for the expenses recorded before the request.
 */
const ORIGINAL_COLUMNS = [
  ['original_currency', 'TEXT'],
  ['original_amount', 'INTEGER'],
  ['original_rate', 'TEXT'],
] as const;

/**
 * Makes the ledger's tables what the stores read, on a file that may have been made before the split kinds (request 7): there,
 * every expense was split equally, which is the default the column takes. It adds the columns of an expense paid in another
 * currency, which a file made before request 21 does not have (docs/adr/0020).
 */
export function prepareLedgerSchema(connection: DatabaseSync): void {
  connection.exec(LEDGER_SCHEMA);
  const columns = (connection.prepare('PRAGMA table_info(expenses)').all() as Array<{ name: string }>).map(
    column => column.name,
  );
  if (!columns.includes('split_kind')) {
    connection.exec("ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'");
  }
  // The expenses recorded before categories (request 24) are `other`, the default the column takes.
  if (!columns.includes('category')) {
    connection.exec("ALTER TABLE expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  }
  for (const [name, type] of ORIGINAL_COLUMNS) {
    if (!columns.includes(name)) connection.exec(`ALTER TABLE expenses ADD COLUMN ${name} ${type}`);
  }
  // The group's audit of the changes of money (request 28, docs/adr/0027): one row per entry, written with the change.
  connection.exec(LEDGER_AUDIT_SCHEMA);
}

/** The columns an expense row is read by, in the order `ExpenseRow` lists them. */
export const EXPENSE_COLUMNS =
  'id, group_id, description, amount, date, paid_by, split_kind, version, original_currency, original_amount, original_rate, category';

/** An expense's row, as the store reads it (`EXPENSE_COLUMNS`). */
export type ExpenseRow = {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  date: string;
  paid_by: string;
  split_kind: string;
  version: number;
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
  category: string;
};

/** What an expense was paid in, as its row keeps it; undefined for an expense in the group's currency (request 21). */
export function originalOfRow(row: ExpenseRow): OriginalAmountSnapshot | undefined {
  if (row.original_currency === null) return undefined;
  return {
    currency: String(row.original_currency),
    amount: Number(row.original_amount),
    rate: String(row.original_rate),
  };
}

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
    const row = connection.prepare(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE id = ?`).get(expenseId) as
      ExpenseRow | undefined;
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
      original: originalOfRow(row),
      category: String(row.category || DEFAULT_CATEGORY) as Category,
      version: Number(row.version),
    });
  }

  async save(expense: Expense): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = expense.toSnapshot();
    const connection = this.database.connection;
    const original = snapshot.original;
    if (snapshot.version === 0) {
      connection
        .prepare(
          'INSERT INTO expenses (id, group_id, description, amount, date, paid_by, split_kind, version, original_currency, original_amount, original_rate, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
          original?.currency ?? null,
          original?.amount ?? null,
          original?.rate ?? null,
          snapshot.category,
        );
    } else {
      const { changes } = connection
        .prepare(
          'UPDATE expenses SET description = ?, amount = ?, date = ?, split_kind = ?, original_currency = ?, original_amount = ?, original_rate = ?, category = ?, version = ? WHERE id = ? AND version = ?',
        )
        .run(
          snapshot.description,
          snapshot.amount,
          snapshot.date,
          snapshot.splitKind,
          original?.currency ?? null,
          original?.amount ?? null,
          original?.rate ?? null,
          snapshot.category,
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
    recordAudit(connection, snapshot.groupId, expense.audited);
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
    recordAudit(connection, snapshot.groupId, expense.audited);
    return Result.ok(undefined);
  }
}

const changedSinceRead = () => new ConcurrencyConflictException('Ledger', 'The expense changed since it was read');
