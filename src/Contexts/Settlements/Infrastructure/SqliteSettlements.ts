import { ConcurrencyConflictException } from '@Architecture/Domain';
import { ISettlementBooks } from '@Contexts/Settlements/Application/ISettlementBooks';
import { ISettlementQueries, SettledTransfer, SettlementView } from '@Contexts/Settlements/Domain/ISettlementQueries';
import { SettlementBook } from '@Contexts/Settlements/Domain/SettlementBook/SettlementBook';

import { SettlementsDatabase } from './SettlementsDatabase';

type BookRow = { id: string; version: number };
type SettlementRow = { id: string; group_id: string; payer: string; payee: string; amount: number; at: string };

/**
 * The settlements in SQLite: the book the use cases load and save (`ISettlementBooks`), and the read side `GetSettlement` and Ledger's
 * `SettledAmounts` read (`ISettlementQueries`). The book's version is checked and stored with the settlements it recorded, in one
 * transaction that holds the database's write lock, so of two writers from one version the second is refused and nothing of its
 * change is kept (CONC-OPTIMISTIC, ADR 11).
 */
export class SqliteSettlements implements ISettlementBooks, ISettlementQueries {
  constructor(private readonly database: SettlementsDatabase) {}

  async bookOf(groupId: string): Promise<SettlementBook> {
    const row = this.database.connection
      .prepare('SELECT id, version FROM settlement_books WHERE group_id = ?')
      .get(groupId) as BookRow | undefined;
    if (!row) return SettlementBook.open(groupId);
    return SettlementBook.fromSnapshot({ id: row.id, groupId, version: row.version });
  }

  async save(book: SettlementBook): Promise<void> {
    const connection = this.database.connection;
    connection.exec('BEGIN IMMEDIATE');
    try {
      const stored = connection.prepare('SELECT version FROM settlement_books WHERE group_id = ?').get(book.groupId) as
        { version: number } | undefined;
      // A book never stored is at version 0; any other is at the version it was stored at.
      if ((stored?.version ?? 0) !== book.version) {
        throw new ConcurrencyConflictException(
          'Settlements',
          'The settlements of the group changed since they were read',
        );
      }
      if (stored) {
        connection
          .prepare('UPDATE settlement_books SET version = ? WHERE group_id = ?')
          .run(book.version + 1, book.groupId);
      } else {
        connection
          .prepare('INSERT INTO settlement_books (id, group_id, version) VALUES (?, ?, ?)')
          .run(book.bookId, book.groupId, book.version + 1);
      }
      const insert = connection.prepare(
        'INSERT INTO settlements (id, group_id, payer, payee, amount, method, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const settlement of book.recorded()) {
        insert.run(
          settlement.id,
          settlement.groupId,
          settlement.from,
          settlement.to,
          settlement.amount,
          settlement.method,
          settlement.status,
          settlement.at,
        );
      }
      connection.exec('COMMIT');
    } catch (error) {
      connection.exec('ROLLBACK');
      throw error;
    }
  }

  async settlementOf(id: string): Promise<SettlementView | undefined> {
    const row = this.database.connection
      .prepare('SELECT id, group_id, payer, payee, amount, at FROM settlements WHERE id = ?')
      .get(id) as SettlementRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      groupId: row.group_id,
      from: row.payer,
      to: row.payee,
      amount: row.amount,
      method: 'cash',
      status: 'paid',
      at: row.at,
    };
  }

  async settledOf(groupId: string): Promise<SettledTransfer[]> {
    const rows = this.database.connection
      .prepare('SELECT payer, payee, amount FROM settlements WHERE group_id = ?')
      .all(groupId) as { payer: string; payee: string; amount: number }[];
    return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.amount }));
  }
}
