import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/** The books' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqliteSettlementBookRepository implements ISettlementBookRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async findByGroup(groupId: Id): Promise<SettlementBook> {
    const row = this.database.connection
      .prepare('SELECT version FROM settlement_books WHERE group_id = ?')
      .get(groupId.value) as { version: number } | undefined;
    return SettlementBook.open(groupId, row ? Number(row.version) : 0);
  }

  async save(book: SettlementBook): Promise<IResult> {
    const { connection } = this.database;
    const groupId = book._id.value;
    const conflict = () =>
      Result.fail(
        new ConcurrencyConflictException('Settlements', 'The settlements of the group changed since they were read', {
          groupId,
        }),
      );

    if (book.version === 0) {
      const { changes } = connection
        .prepare('INSERT OR IGNORE INTO settlement_books (group_id, version) VALUES (?, 1)')
        .run(groupId);
      if (changes === 0) return conflict();
    } else {
      const { changes } = connection
        .prepare('UPDATE settlement_books SET version = version + 1 WHERE group_id = ? AND version = ?')
        .run(groupId, book.version);
      if (changes === 0) return conflict();
    }

    for (const settlement of book.decided) {
      connection
        .prepare(
          'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          settlement.id.value,
          groupId,
          settlement.payer.value,
          settlement.payee.value,
          settlement.amount,
          'cash',
          'paid',
          settlement.at.toISOString(),
        );
    }
    return Result.ok();
  }
}
