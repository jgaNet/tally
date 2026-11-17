import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';

/**
 * The tables of the settlements: a group's book is a row holding its version, and each settlement is a row of its own. The
 * book's row is what a save checks (docs/adr/0013); a settlement is never changed once recorded.
 */
export function prepareSettlementSchema(connection: DatabaseSync): void {
  connection.exec(
    [
      'CREATE TABLE IF NOT EXISTS settlement_books (group_id TEXT PRIMARY KEY, version INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payer_id TEXT NOT NULL, payee_id TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, recorded_at TEXT NOT NULL)',
    ].join(';\n'),
  );
}

/**
 * The settlement books' store over SQLite (docs/adr/0013). Its methods run inside a transaction: the use case's. A save of a book
 * read at a version another writer has moved past changes nothing and answers a conflict, so the use case re-reads and decides
 * again (CONC-OPTIMISTIC). A group's first settlement inserts its book's row: two first settlements at once meet the same check.
 */
export class SqliteSettlementBooks implements ISettlementBooks {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareSettlementSchema);
  }

  async get(groupId: string): Promise<SettlementBook> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare('SELECT version FROM settlement_books WHERE group_id = ?')
      .get(groupId) as { version: number } | undefined;
    return SettlementBook.fromSnapshot({ groupId, version: row ? Number(row.version) : 0 });
  }

  async save(book: SettlementBook): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const connection = this.database.connection;
    const groupId = book.groupId;
    if (book.version === 0) {
      const { changes } = connection
        .prepare('INSERT INTO settlement_books (group_id, version) VALUES (?, ?) ON CONFLICT (group_id) DO NOTHING')
        .run(groupId, 1);
      if (changes === 0) return Result.fail(changedSinceRead());
    } else {
      const { changes } = connection
        .prepare('UPDATE settlement_books SET version = ? WHERE group_id = ? AND version = ?')
        .run(book.version + 1, groupId, book.version);
      if (changes === 0) return Result.fail(changedSinceRead());
    }

    const insert = connection.prepare(
      'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const settlement of book.recorded) {
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
    return Result.ok(undefined);
  }
}

const changedSinceRead = () =>
  new ConcurrencyConflictException('Settlements', 'The settlements of the group changed since they were read');

/** The settlement a row holds, as `GetSettlement` answers it. Exported for the read side of the same tables. */
export type SettlementRow = {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: string;
  status: string;
  recorded_at: string;
};

export function settlementView(row: SettlementRow): SettlementView {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    from: String(row.payer_id),
    to: String(row.payee_id),
    amount: Number(row.amount),
    method: String(row.method) as SettlementView['method'],
    status: String(row.status) as SettlementView['status'],
    at: String(row.recorded_at),
  };
}
