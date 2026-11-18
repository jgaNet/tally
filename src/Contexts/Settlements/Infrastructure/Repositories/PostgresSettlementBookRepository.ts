import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import {
  FeeBorneBy,
  ISettlementSnapshot,
  SettlementMethod,
  SettlementStatus,
} from '@Contexts/Settlements/Domain/Settlement/DTOs';
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
    ALTER TABLE settlement_books ADD COLUMN IF NOT EXISTS fee_borne_by TEXT NOT NULL DEFAULT 'payee';
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
    ALTER TABLE settlements ADD COLUMN IF NOT EXISTS settled_amount INTEGER;
    ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_amount INTEGER;
    ALTER TABLE settlements ADD COLUMN IF NOT EXISTS fee_borne_by TEXT;
    ALTER TABLE settlements ADD COLUMN IF NOT EXISTS original_currency TEXT;
    ALTER TABLE settlements ADD COLUMN IF NOT EXISTS original_amount INTEGER;
    ALTER TABLE settlements ADD COLUMN IF NOT EXISTS original_rate TEXT;
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
    CREATE TABLE IF NOT EXISTS settlement_admin_log (
      seq BIGSERIAL PRIMARY KEY,
      id TEXT NOT NULL,
      at TEXT NOT NULL,
      by_account TEXT NOT NULL,
      action TEXT NOT NULL,
      subject_id TEXT NOT NULL
    );
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
  /** What the settlement settles (request 38); null for one recorded before it, which settles its amount. */
  settled_amount: number | null;
  /** The provider's fee and who bore it, for a settlement through the provider asked from request 38 on; null otherwise. */
  fee_amount: number | null;
  fee_borne_by: FeeBorneBy | null;
  /** What was paid in another currency and its rate (request 39); all null for one paid in the group's currency. */
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
}

/** A settlement row, as the domain's snapshot of it. */
export function settlementOf(row: SettlementRow, contested = false): ISettlementSnapshot {
  return {
    _id: row.id,
    groupId: row.group_id,
    from: row.payer,
    to: row.payee,
    amount: row.amount,
    settled: row.settled_amount ?? row.amount,
    fee: row.fee_borne_by && row.fee_amount !== null ? { amount: row.fee_amount, borneBy: row.fee_borne_by } : null,
    original:
      row.original_currency && row.original_amount !== null && row.original_rate
        ? { currency: row.original_currency, amount: row.original_amount, rate: row.original_rate }
        : null,
    at: row.at,
    method: row.method,
    status: row.status,
    providerPaymentId: row.provider_payment_id,
    payUrl: row.pay_url,
    contested,
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
    const row = await this.database.get<{
      book_id: string;
      group_id: string;
      version: number;
      fee_borne_by: FeeBorneBy;
    }>('SELECT book_id, group_id, version, fee_borne_by FROM settlement_books WHERE group_id = ?', [groupId]);
    if (!row) return null;

    const settlements = await this.database.all<SettlementRow>(
      'SELECT * FROM settlements WHERE group_id = ? ORDER BY recorded_seq',
      [groupId],
    );
    // A settlement is contested once: the status it has now does not say whether it was (request 33).
    const contested = new Set(
      (
        await this.database.all<{ settlement_id: string }>(
          `SELECT DISTINCT h.settlement_id FROM settlement_history h
             JOIN settlements s ON s.id = h.settlement_id
            WHERE s.group_id = ? AND h.status = 'contested'`,
          [groupId],
        )
      ).map(line => line.settlement_id),
    );
    return SettlementBook.fromSnapshot({
      _id: row.book_id,
      groupId: row.group_id,
      version: row.version,
      settlements: settlements.map(settlement => settlementOf(settlement, contested.has(settlement.id))),
      feeBorneBy: row.fee_borne_by,
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
        'INSERT INTO settlement_books (group_id, book_id, version, fee_borne_by) VALUES (?, ?, 1, ?) ON CONFLICT (group_id) DO NOTHING',
        [snapshot.groupId, snapshot._id, snapshot.feeBorneBy ?? 'payee'],
      );
      if (inserted.changes === 0) return conflict(snapshot.groupId);
    } else {
      const moved = await this.database.run(
        'UPDATE settlement_books SET version = version + 1, fee_borne_by = COALESCE(?, fee_borne_by) WHERE group_id = ? AND version = ?',
        [snapshot.feeBorneBy, snapshot.groupId, snapshot.version],
      );
      if (moved.changes === 0) return conflict(snapshot.groupId);
    }

    for (const settlement of snapshot.recorded) await this.insertSettlement(settlement);
    for (const settlement of snapshot.moved) {
      await this.database.run('UPDATE settlements SET group_id = ? WHERE id = ?', [settlement.groupId, settlement._id]);
    }
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
    // The administrators' decisions, in the transaction of the decision: an entry is never changed or removed (request 33).
    for (const decision of snapshot.decisions) {
      await this.database.run(
        'INSERT INTO settlement_admin_log (id, at, by_account, action, subject_id) VALUES (?, ?, ?, ?, ?)',
        [decision.id, decision.at, decision.by, decision.action, decision.subjectId],
      );
    }
    return Result.ok();
  }

  private async insertSettlement(settlement: ISettlementSnapshot): Promise<void> {
    await this.database.run(
      'INSERT INTO settlements (id, group_id, payer, payee, amount, method, status, at, provider_payment_id, pay_url, settled_amount, fee_amount, fee_borne_by, original_currency, original_amount, original_rate, recorded_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(recorded_seq), 0) + 1 FROM settlements))',
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
        settlement.settled,
        settlement.fee?.amount ?? null,
        settlement.fee?.borneBy ?? null,
        settlement.original?.currency ?? null,
        settlement.original?.amount ?? null,
        settlement.original?.rate ?? null,
      ],
    );
  }

  /**
   * The book kept is saved as `save()` saves it; the book of the group merged is then removed at the version it was read at, and
   * its audit entries move to the group kept (request 31). Both are in the transaction of the merge.
   */
  async absorb(kept: SettlementBook, merged: SettlementBook): Promise<IResult> {
    const saved = await this.save(kept);
    if (saved.isFailure()) return saved;

    const deleted = await this.database.run('DELETE FROM settlement_books WHERE group_id = ? AND version = ?', [
      merged.groupId,
      merged.version,
    ]);
    if (deleted.changes === 0) return conflict(merged.groupId);
    await this.database.run('UPDATE settlement_audit SET group_id = ? WHERE group_id = ?', [
      kept.groupId,
      merged.groupId,
    ]);
    return Result.ok();
  }
}

function conflict(groupId: string): IResult {
  return Result.fail(
    new ConcurrencyConflictException('Settlements', 'The settlements of the group changed since they were read', {
      groupId,
    }),
  );
}
