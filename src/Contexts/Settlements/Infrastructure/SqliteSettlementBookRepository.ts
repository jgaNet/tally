import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

interface BookRow {
  id: string;
  group_id: string;
  version: number;
}

/**
 * The books, in the application's file. It runs inside the command's transaction, which holds the file, so it takes no lock of
 * its own. A book that is not at the version it was read at, or a group's first settlement that another writer stored first, is
 * a conflict; the command's transaction is rolled back with it, so the book and its settlements are stored together or not at all.
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
    return SettlementBook.fromSnapshot({ id: row.id, groupId: row.group_id, version: row.version });
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
    for (const settlement of book.recorded) {
      this.database.run(
        `INSERT INTO settlements (id, group_id, payer, payee, amount, method, status, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        settlement.id.value,
        settlement.groupId.value,
        settlement.payer.value,
        settlement.payee.value,
        settlement.amount,
        settlement.method,
        settlement.status,
        settlement.at.toISOString(),
      );
    }
    return Result.ok();
  }
}

const conflict = (groupId: string): IResult =>
  Result.fail(new ConcurrencyConflictException('Settlements', 'The group settlements have changed', { groupId }));
