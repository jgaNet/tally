import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';

/**
 * The tables of expenses: one row per expense, one per share in the order of the split, and the balance read model's
 * entries: one per payer (the amount owed to them) and one per share (what its member owes), so an expense's entries add
 * up to 0 (ADR 1, T4). A database that held expenses before the entries existed is backfilled from them, once.
 */
export function createExpensesTables(database: SqliteDatabase): void {
  const connection = database.connection;
  const hadEntries = connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'balance_entries'")
    .get();
  connection.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      spent_on TEXT NOT NULL,
      paid_by TEXT NOT NULL,
      split_kind TEXT NOT NULL DEFAULT 'equal',
      version INTEGER NOT NULL,
      recorded_seq INTEGER
    );
    CREATE TABLE IF NOT EXISTS expense_shares (
      expense_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      PRIMARY KEY (expense_id, position)
    );
    CREATE TABLE IF NOT EXISTS balance_entries (
      expense_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS balance_entries_by_group ON balance_entries (group_id);
  `);
  // An expense recorded before the split kinds existed was split equally, which the default says.
  const columns = connection.prepare('PRAGMA table_info(expenses)').all() as unknown as { name: string }[];
  if (!columns.some(column => column.name === 'split_kind')) {
    connection.exec("ALTER TABLE expenses ADD COLUMN split_kind TEXT NOT NULL DEFAULT 'equal'");
  }
  // The order an expense was first recorded in: a number given at its insert and never changed by an edit (request 8).
  // An expense recorded before it existed is numbered by its row, which was made in the order of recording.
  if (!columns.some(column => column.name === 'recorded_seq')) {
    connection.exec('ALTER TABLE expenses ADD COLUMN recorded_seq INTEGER');
  }
  connection.exec('UPDATE expenses SET recorded_seq = rowid WHERE recorded_seq IS NULL');
  // What was paid in another currency, and its rate (request 21): NULL for an expense in the group's currency, and for
  // every expense recorded before these columns existed.
  for (const [name, type] of [
    ['original_currency', 'TEXT'],
    ['original_amount', 'INTEGER'],
    ['original_rate', 'TEXT'],
  ]) {
    if (!columns.some(column => column.name === name))
      connection.exec(`ALTER TABLE expenses ADD COLUMN ${name} ${type}`);
  }
  // The category of an expense (request 24): `other` for every expense recorded before categories existed.
  if (!columns.some(column => column.name === 'category')) {
    connection.exec("ALTER TABLE expenses ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  }
  if (!hadEntries) {
    connection.exec(`
      INSERT INTO balance_entries (expense_id, group_id, member_id, amount)
        SELECT id, group_id, paid_by, amount FROM expenses;
      INSERT INTO balance_entries (expense_id, group_id, member_id, amount)
        SELECT s.expense_id, e.group_id, s.member_id, -s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id;
    `);
  }
}

interface ExpenseRow {
  id: string;
  group_id: string;
  description: string;
  amount: number;
  spent_on: string;
  paid_by: string;
  split_kind: SplitKind;
  version: number;
  recorded_seq: number;
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
  category: Category;
}

interface ShareRow {
  member_id: string;
  amount: number;
}

/** The expenses as aggregates, over the application's SQLite file, inside the transaction of the command. */
export class SqliteExpenseRepository implements IExpenseRepository {
  constructor(private database: SqliteDatabase) {
    createExpensesTables(database);
  }

  async findById(id: string): Promise<Expense | null> {
    const connection = this.database.connection;
    const row = connection.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as ExpenseRow | undefined;
    if (!row) return null;

    const shares = connection
      .prepare('SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position')
      .all(id) as unknown as ShareRow[];
    return Expense.fromSnapshot({
      _id: row.id,
      groupId: row.group_id,
      description: row.description,
      amount: row.amount,
      date: row.spent_on,
      paidBy: row.paid_by,
      shares: shares.map(share => ({ memberId: share.member_id, amount: share.amount })),
      splitKind: row.split_kind,
      original:
        row.original_currency === null
          ? null
          : { currency: row.original_currency, amount: row.original_amount ?? 0, rate: row.original_rate ?? '' },
      category: row.category,
      version: row.version,
    });
  }

  /**
   * A new expense (version 0) is inserted at version 1. An expense read at a version is updated only where the row is
   * still at that version, as SQL makes the check atomic: no row changed means another writer got there first (ADR 8).
   */
  async save(expense: Expense): Promise<IResult> {
    const snapshot: IExpenseSnapshot = expense.toSnapshot();
    return snapshot.version === 0 ? this.insert(snapshot) : this.update(snapshot);
  }

  /** The expense is deleted at the version it was read at; its shares and its balance entries go with it. */
  async remove(expense: Expense): Promise<IResult> {
    const { _id: id, version } = expense.toSnapshot();
    const connection = this.database.connection;

    const deleted = connection.prepare('DELETE FROM expenses WHERE id = ? AND version = ?').run(id, version);
    if (deleted.changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Ledger', 'The expense changed since it was read', { id }));
    }
    connection.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(id);
    connection.prepare('DELETE FROM balance_entries WHERE expense_id = ?').run(id);
    return Result.ok();
  }

  private insert(snapshot: IExpenseSnapshot): IResult {
    const connection = this.database.connection;
    const stored = connection.prepare('SELECT version FROM expenses WHERE id = ?').get(snapshot._id);
    if (stored) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The expense is already stored', { id: snapshot._id }),
      );
    }
    connection
      .prepare(
        'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, split_kind, original_currency, original_amount, original_rate, category, version, recorded_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(recorded_seq), 0) + 1 FROM expenses))',
      )
      .run(
        snapshot._id,
        snapshot.groupId,
        snapshot.description,
        snapshot.amount,
        snapshot.date,
        snapshot.paidBy,
        snapshot.splitKind,
        snapshot.original?.currency ?? null,
        snapshot.original?.amount ?? null,
        snapshot.original?.rate ?? null,
        snapshot.category,
        snapshot.version + 1,
      );
    this.writeShares(snapshot);
    return Result.ok();
  }

  private update(snapshot: IExpenseSnapshot): IResult {
    const connection = this.database.connection;
    const { _id: id, description, amount, date, splitKind, version } = snapshot;

    const updated = connection
      .prepare(
        'UPDATE expenses SET description = :description, amount = :amount, spent_on = :date, split_kind = :splitKind, original_currency = :originalCurrency, original_amount = :originalAmount, original_rate = :originalRate, category = :category, version = :next WHERE id = :id AND version = :version',
      )
      .run({
        id,
        description,
        amount,
        date,
        splitKind,
        originalCurrency: snapshot.original?.currency ?? null,
        originalAmount: snapshot.original?.amount ?? null,
        originalRate: snapshot.original?.rate ?? null,
        category: snapshot.category,
        version,
        next: version + 1,
      });
    if (updated.changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Ledger', 'The expense changed since it was read', { id }));
    }
    connection.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(id);
    connection.prepare('DELETE FROM balance_entries WHERE expense_id = ?').run(id);
    this.writeShares(snapshot);
    return Result.ok();
  }

  /**
   * The shares in the order of the split, and the balance read model's entries: one for the payer (the amount owed to
   * them) and one per share (what its member owes), written in the same transaction as the expense, so the entries of
   * this expense add up to 0 (ADR 1, T4).
   */
  private writeShares(snapshot: IExpenseSnapshot): void {
    const connection = this.database.connection;
    snapshot.shares.forEach((share, position) =>
      connection
        .prepare('INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)')
        .run(snapshot._id, position, share.memberId, share.amount),
    );
    const entry = connection.prepare(
      'INSERT INTO balance_entries (expense_id, group_id, member_id, amount) VALUES (?, ?, ?, ?)',
    );
    entry.run(snapshot._id, snapshot.groupId, snapshot.paidBy, snapshot.amount);
    snapshot.shares.forEach(share => entry.run(snapshot._id, snapshot.groupId, share.memberId, -share.amount));
  }
}
