import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Settlement, SettlementMethod, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

interface BookRow {
  id: string;
  group_id: string;
  version: number;
}

/** One settlement as the table keeps it. */
export interface SettlementRow {
  id: string;
  group_id: string;
  payer: string;
  payee: string;
  amount: number;
  method: SettlementMethod;
  status: SettlementStatus;
  recorded_at: string;
  provider_payment_id: string | null;
  pay_url: string | null;
}

/**
 * The books, in the application's file. It runs inside the command's transaction, which holds the file, so it takes no lock of
 * its own. A book is read with every settlement of its group, as they are kept (a refund and a webhook find theirs in it). A book that is not at the version it was
 * read at, or a group's first settlement that another writer stored first, is a conflict; the command's transaction is rolled back
 * with it, so the book, its settlements and its status changes are stored together or not at all.
 */
export class SqliteSettlementBookRepository implements ISettlementBookRepository {
  constructor(private database: SqliteDatabase) {
    createSettlementsTables(database);
  }

  async findByGroupId(groupId: Id): Promise<SettlementBook | null> {
    const row = this.database.get<BookRow>(
      'SELECT id, group_id, version FROM settlement_books WHERE group_id = ?',
      groupId.value,
    );
    if (!row) return null;
    const settlements = this.database
      .all<SettlementRow>(
        `SELECT id, group_id, payer, payee, amount, method, status, recorded_at, provider_payment_id, pay_url
         FROM settlements WHERE group_id = ? ORDER BY recorded_at, id`,
        groupId.value,
      )
      .map(toSettlement);
    return SettlementBook.fromSnapshot({ id: row.id, groupId: row.group_id, version: row.version, settlements });
  }

  async findBySettlementId(settlementId: Id): Promise<SettlementBook | null> {
    const row = this.database.get<{ group_id: string }>(
      'SELECT group_id FROM settlements WHERE id = ?',
      settlementId.value,
    );
    return row ? this.findByGroupId(new Id(row.group_id)) : null;
  }

  async findByProviderPaymentId(paymentId: string): Promise<SettlementBook | null> {
    const row = this.database.get<{ group_id: string }>(
      'SELECT group_id FROM settlements WHERE provider_payment_id = ?',
      paymentId,
    );
    return row ? this.findByGroupId(new Id(row.group_id)) : null;
  }

  async save(book: SettlementBook): Promise<IResult> {
    if (book.version === 0) {
      // The group's first settlement opens its book; a book another writer opened first is left as it is, and that is a conflict.
      const opened = this.database.run(
        'INSERT OR IGNORE INTO settlement_books (id, group_id, version) VALUES (?, ?, 1)',
        book._id.value,
        book.groupId.value,
      );
      if (!opened) return conflict(book.groupId.value);
    } else {
      const changed = this.database.run(
        'UPDATE settlement_books SET version = ? WHERE id = ? AND version = ?',
        book.version + 1,
        book._id.value,
        book.version,
      );
      if (!changed) return conflict(book.groupId.value);
    }
    for (const settlement of book.created) {
      this.database.run(
        `INSERT INTO settlements (id, group_id, payer, payee, amount, method, status, recorded_at, provider_payment_id, pay_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        settlement.id.value,
        settlement.groupId.value,
        settlement.payer.value,
        settlement.payee.value,
        settlement.amount,
        settlement.method,
        settlement.status,
        settlement.at.toISOString(),
        settlement.provider?.paymentId ?? null,
        settlement.provider?.payUrl ?? null,
      );
    }
    for (const settlement of book.statusChangedSinceRead) {
      this.database.run('UPDATE settlements SET status = ? WHERE id = ?', settlement.status, settlement.id.value);
    }
    return Result.ok();
  }
}

/** A settlement as the book reads it: its status, and its provider's payment when it has one. */
export const toSettlement = (row: SettlementRow): Settlement =>
  new Settlement(
    new Id(row.id),
    new Id(row.group_id),
    new Id(row.payer),
    new Id(row.payee),
    row.amount,
    row.method,
    row.status,
    new Date(row.recorded_at),
    row.provider_payment_id && row.pay_url ? { paymentId: row.provider_payment_id, payUrl: row.pay_url } : null,
  );

const conflict = (groupId: string): IResult =>
  Result.fail(new ConcurrencyConflictException('Settlements', 'The group settlements have changed', { groupId }));
