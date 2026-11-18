import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ISettlementSnapshot, SettlementMethod, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * The tables of settlements: one book per group, at the version it was last saved at (the check of CONC-OPTIMISTIC), and one
 * row per settlement, in the order it was recorded (ADR 8). A settlement through the provider keeps the provider's payment id and
 * its link; a cash settlement keeps neither.
 */
export function createSettlementTables(database: PostgresDatabase): void {
  // The status lines (request 19): one per status a settlement had, in the order the book gave them.
  database.define(`
    CREATE TABLE IF NOT EXISTS settlement_books (
      group_id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settlements (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      payer TEXT NOT NULL,
      payee TEXT NOT NULL,
      amount INTEGER NOT NULL,
      method TEXT NOT NULL DEFAULT 'cash',
      status TEXT NOT NULL DEFAULT 'paid',
      at TEXT NOT NULL,
      provider_payment_id TEXT,
      pay_url TEXT,
      recorded_seq INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id);
    CREATE INDEX IF NOT EXISTS settlements_by_provider_payment ON settlements (provider_payment_id);
    CREATE TABLE IF NOT EXISTS settlement_history (
      seq BIGSERIAL PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      status TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS settlement_history_by_settlement ON settlement_history (settlement_id);
    CREATE TABLE IF NOT EXISTS settlement_audit (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      at TEXT NOT NULL,
      by_account TEXT NOT NULL,
      action TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS settlement_audit_by_group ON settlement_audit (group_id);
  `);
}

/** A settlement row as the table keeps it. */
export interface SettlementRow {
  id: string;
  group_id: string;
  payer: string;
  payee: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
  at: string;
  provider_payment_id: string | null;
  pay_url: string | null;
}

/** A settlement row, as the domain's snapshot of it. */
export function settlementOf(row: SettlementRow): ISettlementSnapshot {
  return {
    _id: row.id,
    groupId: row.group_id,
    from: row.payer,
    to: row.payee,
    amount: row.amount,
    at: row.at,
    method: row.method,
    status: row.status,
    providerPaymentId: row.provider_payment_id,
    payUrl: row.pay_url,
  };
}

/**
 * The settlement books over the application's PostgreSQL database, inside the transaction of the command. A first book is inserted at
 * version 1, where a second writer's insert of the same group does nothing; a later one moves the version on only where the
 * stored version is the one the book was read at. Either refusal is a ConcurrencyConflictException (CONC-OPTIMISTIC). A save
 * inserts the settlements decided and updates the status of those the provider moved.
 */
export class PostgresSettlementBookRepository implements ISettlementBookRepository {
  constructor(private database: PostgresDatabase) {
    createSettlementTables(database);
  }

  async findByGroupId(groupId: string): Promise<SettlementBook | null> {
    const row = await this.database.get<{ book_id: string; group_id: string; version: number }>(
      'SELECT book_id, group_id, version FROM settlement_books WHERE group_id = ?',
      [groupId],
    );
    if (!row) return null;

    const settlements = await this.database.all<SettlementRow>(
      'SELECT * FROM settlements WHERE group_id = ? ORDER BY recorded_seq',
      [groupId],
    );
    return SettlementBook.fromSnapshot({
      _id: row.book_id,
      groupId: row.group_id,
      version: row.version,
      settlements: settlements.map(settlementOf),
    });
  }

  async findByPaymentId(paymentId: string): Promise<SettlementBook | null> {
    const row = await this.database.get<{ group_id: string }>(
      'SELECT group_id FROM settlements WHERE provider_payment_id = ?',
      [paymentId],
    );
    return row ? this.findByGroupId(row.group_id) : null;
  }

  async findBySettlementId(settlementId: string): Promise<SettlementBook | null> {
    const row = await this.database.get<{ group_id: string }>('SELECT group_id FROM settlements WHERE id = ?', [
      settlementId,
    ]);
    return row ? this.findByGroupId(row.group_id) : null;
  }

  async save(book: SettlementBook): Promise<IResult> {
    const snapshot = book.toSnapshot();

    if (snapshot.version === 0) {
      const inserted = await this.database.run(
        'INSERT INTO settlement_books (group_id, book_id, version) VALUES (?, ?, 1) ON CONFLICT (group_id) DO NOTHING',
        [snapshot.groupId, snapshot._id],
      );
      if (inserted.changes === 0) return conflict(snapshot.groupId);
    } else {
      const moved = await this.database.run(
        'UPDATE settlement_books SET version = version + 1 WHERE group_id = ? AND version = ?',
        [snapshot.groupId, snapshot.version],
      );
      if (moved.changes === 0) return conflict(snapshot.groupId);
    }

    for (const settlement of snapshot.recorded) await this.insertSettlement(settlement);
    for (const settlement of snapshot.changed) {
      await this.database.run('UPDATE settlements SET status = ? WHERE id = ?', [settlement.status, settlement._id]);
    }
    for (const line of snapshot.history) {
      await this.database.run('INSERT INTO settlement_history (settlement_id, status, at) VALUES (?, ?, ?)', [
        line.settlementId,
        line.status,
        line.at,
      ]);
    }
    // The entries of the changes made, in the transaction of the book's version: an entry is never changed (request 28).
    for (const entry of book.newAuditEntries) {
      await this.database.run(
        'INSERT INTO settlement_audit (id, group_id, at, by_account, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [entry.id, entry.groupId, entry.at, entry.by, entry.action, entry.subjectId, entry.amount],
      );
    }
    return Result.ok();
  }

  private async insertSettlement(settlement: ISettlementSnapshot): Promise<void> {
    await this.database.run(
      'INSERT INTO settlements (id, group_id, payer, payee, amount, method, status, at, provider_payment_id, pay_url, recorded_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(recorded_seq), 0) + 1 FROM settlements))',
      [
        settlement._id,
        settlement.groupId,
        settlement.from,
        settlement.to,
        settlement.amount,
        settlement.method,
        settlement.status,
        settlement.at,
        settlement.providerPaymentId,
        settlement.payUrl,
      ],
    );
  }
}

function conflict(groupId: string): IResult {
  return Result.fail(
    new ConcurrencyConflictException('Settlements', 'The settlements of the group changed since they were read', {
      groupId,
    }),
  );
}
