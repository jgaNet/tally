import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  Settlement,
  SettlementLine,
  SettlementMethod,
  SettlementStatus,
} from '@Contexts/Settlements/Domain/Settlement/Settlement';
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
export class PostgresSettlementBookRepository implements ISettlementBookRepository {
  constructor(private database: PostgresDatabase) {
    createSettlementsTables(database);
  }

  async findByGroupId(groupId: Id): Promise<SettlementBook | null> {
    const row = await this.database.get<BookRow>(
      'SELECT id, group_id, version FROM settlement_books WHERE group_id = ?',
      groupId.value,
    );
    if (!row) return null;
    const history = await historyOfGroup(this.database, groupId.value);
    const settlements = (
      await this.database.all<SettlementRow>(
        `SELECT id, group_id, payer, payee, amount, method, status, recorded_at, provider_payment_id, pay_url
         FROM settlements WHERE group_id = ? ORDER BY recorded_at, id`,
        groupId.value,
      )
    ).map(settled => toSettlement(settled, history.get(settled.id) ?? []));
    return SettlementBook.fromSnapshot({ id: row.id, groupId: row.group_id, version: row.version, settlements });
  }

  async findBySettlementId(settlementId: Id): Promise<SettlementBook | null> {
    const row = await this.database.get<{ group_id: string }>(
      'SELECT group_id FROM settlements WHERE id = ?',
      settlementId.value,
    );
    return row ? this.findByGroupId(new Id(row.group_id)) : null;
  }

  async findByProviderPaymentId(paymentId: string): Promise<SettlementBook | null> {
    const row = await this.database.get<{ group_id: string }>(
      'SELECT group_id FROM settlements WHERE provider_payment_id = ?',
      paymentId,
    );
    return row ? this.findByGroupId(new Id(row.group_id)) : null;
  }

  async save(book: SettlementBook): Promise<IResult> {
    if (book.version === 0) {
      // The group's first settlement opens its book; a book another writer opened first is left as it is, and that is a conflict.
      const opened = await this.database.run(
        'INSERT INTO settlement_books (id, group_id, version) VALUES (?, ?, 1) ON CONFLICT DO NOTHING',
        book._id.value,
        book.groupId.value,
      );
      if (!opened) return conflict(book.groupId.value);
    } else {
      const changed = await this.database.run(
        'UPDATE settlement_books SET version = ? WHERE id = ? AND version = ?',
        book.version + 1,
        book._id.value,
        book.version,
      );
      if (!changed) return conflict(book.groupId.value);
    }
    // A merged group's book is this one now (request 31): its settlements and their audit entries are kept under this group, and its book is gone.
    if (book.absorbedFrom) {
      const from = book.absorbedFrom.value;
      await this.database.run('UPDATE settlements SET group_id = ? WHERE group_id = ?', book.groupId.value, from);
      await this.database.run(
        'UPDATE settlement_audit_entries SET group_id = ? WHERE group_id = ?',
        book.groupId.value,
        from,
      );
      await this.database.run('DELETE FROM settlement_books WHERE group_id = ?', from);
    }
    for (const settlement of book.created) {
      await this.database.run(
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
      await this.database.run('UPDATE settlements SET status = ? WHERE id = ?', settlement.status, settlement.id.value);
    }
    for (const line of book.learnedSinceRead) {
      await this.database.run(
        'INSERT INTO settlement_history (settlement_id, position, status, learned_at) VALUES (?, ?, ?, ?)',
        line.settlementId.value,
        line.position,
        line.status,
        line.at.toISOString(),
      );
    }
    return Result.ok();
  }
}

/** One line of a settlement's history as the table keeps it. */
export interface HistoryRow {
  settlement_id: string;
  status: SettlementStatus;
  learned_at: string;
}

/** The history of every settlement of a group, each settlement's lines the earliest first, read in the same snapshot as its book. */
export const historyOfGroup = async (
  database: PostgresDatabase,
  groupId: string,
): Promise<Map<string, SettlementLine[]>> => {
  const byId = new Map<string, SettlementLine[]>();
  const rows = await database.all<HistoryRow>(
    `SELECT h.settlement_id, h.status, h.learned_at FROM settlement_history h
       JOIN settlements s ON s.id = h.settlement_id
     WHERE s.group_id = ? ORDER BY h.settlement_id, h.position`,
    groupId,
  );
  for (const row of rows) {
    const lines = byId.get(row.settlement_id) ?? [];
    lines.push({ status: row.status, at: new Date(row.learned_at) });
    byId.set(row.settlement_id, lines);
  }
  return byId;
};

/** A settlement as the book reads it: its status, its provider's payment when it has one, and the lines of its history. */
export const toSettlement = (row: SettlementRow, history: readonly SettlementLine[]): Settlement =>
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
    history,
  );

const conflict = (groupId: string): IResult =>
  Result.fail(new ConcurrencyConflictException('Settlements', 'The group settlements have changed', { groupId }));
