import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { SplitKind } from '@Contexts/Ledger/Domain/Expense/Split';
import { Category } from '@Contexts/Ledger/Domain/Expense/Category';
import { AuditEntry } from '@Contexts/Ledger/Domain/Audit/AuditEntry';

/**
 * The tables of expenses: one row per expense, one per share in the order of the split, and the balance read model's
 * entries: one per payer (the amount owed to them) and one per share (what its member owes), so an expense's entries add
 * up to 0 (ADR 1, T4). The audit entries of the changes are kept here too (request 28), in the order they were written.
 * Declared with the database, which makes them when it opens (ADR 20).
 */
export function defineExpensesTables(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      spent_on TEXT NOT NULL,
      paid_by TEXT NOT NULL,
      split_kind TEXT NOT NULL DEFAULT 'equal',
      version INTEGER NOT NULL,
      recorded_seq INTEGER,
      original_currency TEXT,
      original_amount INTEGER,
      original_rate TEXT,
      category TEXT NOT NULL DEFAULT 'other'
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
    CREATE TABLE IF NOT EXISTS audit_entries (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      at TEXT NOT NULL,
      by_account TEXT NOT NULL,
      action TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_entries_by_group ON audit_entries (group_id);
  `);
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

/** The expenses as aggregates, over the application's PostgreSQL database, inside the transaction of the command. */
export class PostgresExpenseRepository implements IExpenseRepository {
  constructor(private database: PostgresDatabase) {
    defineExpensesTables(database);
  }

  async findById(id: string): Promise<Expense | null> {
    const row = await this.database.get<ExpenseRow>('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!row) return null;

    const shares = await this.database.all<ShareRow>(
      'SELECT member_id, amount FROM expense_shares WHERE expense_id = ? ORDER BY position',
      [id],
    );
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
    const saved = snapshot.version === 0 ? await this.insert(snapshot) : await this.update(snapshot);
    if (saved.isSuccess()) await this.writeAudit(expense.newAuditEntries);
    return saved;
  }

  /** The expense is deleted at the version it was read at; its shares and its balance entries go with it. */
  async remove(expense: Expense): Promise<IResult> {
    const { _id: id, version } = expense.toSnapshot();

    const deleted = await this.database.run('DELETE FROM expenses WHERE id = ? AND version = ?', [id, version]);
    if (deleted.changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Ledger', 'The expense changed since it was read', { id }));
    }
    await this.database.run('DELETE FROM expense_shares WHERE expense_id = ?', [id]);
    await this.database.run('DELETE FROM balance_entries WHERE expense_id = ?', [id]);
    await this.writeAudit(expense.newAuditEntries);
    return Result.ok();
  }

  /**
   * The expense moved to its group, with its balance entries: the version it was read at is kept, and the row is updated only where
   * it is still at that version (ADR 8). No entry of the audit is written: a move is no change of money (request 31).
   */
  async move(expense: Expense): Promise<IResult> {
    const { _id: id, groupId, version } = expense.toSnapshot();
    const moved = await this.database.run('UPDATE expenses SET group_id = ? WHERE id = ? AND version = ?', [
      groupId,
      id,
      version,
    ]);
    if (moved.changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Ledger', 'The expense changed since it was read', { id }));
    }
    await this.database.run('UPDATE balance_entries SET group_id = ? WHERE expense_id = ?', [groupId, id]);
    return Result.ok();
  }

  /** The entries of the changes made, written in the transaction of the change; an entry is never changed (request 28). */
  private async writeAudit(entries: readonly AuditEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.database.run(
        'INSERT INTO audit_entries (id, group_id, at, by_account, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [entry.id, entry.groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount],
      );
    }
  }

  private async insert(snapshot: IExpenseSnapshot): Promise<IResult> {
    const stored = await this.database.get('SELECT version FROM expenses WHERE id = ?', [snapshot._id]);
    if (stored) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The expense is already stored', { id: snapshot._id }),
      );
    }
    await this.database.run(
      'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, split_kind, original_currency, original_amount, original_rate, category, version, recorded_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(recorded_seq), 0) + 1 FROM expenses))',
      [
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
      ],
    );
    await this.writeShares(snapshot);
    return Result.ok();
  }

  private async update(snapshot: IExpenseSnapshot): Promise<IResult> {
    const { _id: id, description, amount, date, splitKind, version } = snapshot;

    const updated = await this.database.run(
      'UPDATE expenses SET description = ?, amount = ?, spent_on = ?, split_kind = ?, original_currency = ?, original_amount = ?, original_rate = ?, category = ?, version = ? WHERE id = ? AND version = ?',
      [
        description,
        amount,
        date,
        splitKind,
        snapshot.original?.currency ?? null,
        snapshot.original?.amount ?? null,
        snapshot.original?.rate ?? null,
        snapshot.category,
        version + 1,
        id,
        version,
      ],
    );
    if (updated.changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Ledger', 'The expense changed since it was read', { id }));
    }
    await this.database.run('DELETE FROM expense_shares WHERE expense_id = ?', [id]);
    await this.database.run('DELETE FROM balance_entries WHERE expense_id = ?', [id]);
    await this.writeShares(snapshot);
    return Result.ok();
  }

  /**
   * The shares in the order of the split, and the balance read model's entries: one for the payer (the amount owed to
   * them) and one per share (what its member owes), written in the same transaction as the expense, so the entries of
   * this expense add up to 0 (ADR 1, T4).
   */
  private async writeShares(snapshot: IExpenseSnapshot): Promise<void> {
    for (const [position, share] of snapshot.shares.entries()) {
      await this.database.run(
        'INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES (?, ?, ?, ?)',
        [snapshot._id, position, share.memberId, share.amount],
      );
    }
    await this.database.run(
      'INSERT INTO balance_entries (expense_id, group_id, member_id, amount) VALUES (?, ?, ?, ?)',
      [snapshot._id, snapshot.groupId, snapshot.paidBy, snapshot.amount],
    );
    for (const share of snapshot.shares) {
      await this.database.run(
        'INSERT INTO balance_entries (expense_id, group_id, member_id, amount) VALUES (?, ?, ?, ?)',
        [snapshot._id, snapshot.groupId, share.memberId, -share.amount],
      );
    }
  }
}
