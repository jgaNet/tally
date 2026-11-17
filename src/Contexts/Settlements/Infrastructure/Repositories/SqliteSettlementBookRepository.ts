import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISettlementSnapshot } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * The tables of settlements: one book per group, at the version it was last saved at (the check of CONC-OPTIMISTIC),
 * and one row per settlement recorded, in the order it was recorded (ADR 8).
 */
export function createSettlementTables(database: SqliteDatabase): void {
  database.connection.exec(`
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
      recorded_seq INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS settlements_by_group ON settlements (group_id);
  `);
}

/**
 * The settlement books over the application's SQLite file, inside the transaction of the command. A first book is inserted
 * at version 1, where a second writer's insert of the same group does nothing; a later one moves the version on only where
 * the stored version is the one the book was read at. Either refusal is a ConcurrencyConflictException (CONC-OPTIMISTIC).
 */
export class SqliteSettlementBookRepository implements ISettlementBookRepository {
  constructor(private database: SqliteDatabase) {
    createSettlementTables(database);
  }

  async findByGroupId(groupId: string): Promise<SettlementBook | null> {
    const row = this.database.connection
      .prepare('SELECT book_id, group_id, version FROM settlement_books WHERE group_id = ?')
      .get(groupId) as { book_id: string; group_id: string; version: number } | undefined;
    return row ? SettlementBook.fromSnapshot({ _id: row.book_id, groupId: row.group_id, version: row.version }) : null;
  }

  async save(book: SettlementBook): Promise<IResult> {
    const snapshot = book.toSnapshot();
    const connection = this.database.connection;

    if (snapshot.version === 0) {
      const inserted = connection
        .prepare(
          'INSERT INTO settlement_books (group_id, book_id, version) VALUES (?, ?, 1) ON CONFLICT (group_id) DO NOTHING',
        )
        .run(snapshot.groupId, snapshot._id);
      if (inserted.changes === 0) return conflict(snapshot.groupId);
    } else {
      const moved = connection
        .prepare('UPDATE settlement_books SET version = version + 1 WHERE group_id = ? AND version = ?')
        .run(snapshot.groupId, snapshot.version);
      if (moved.changes === 0) return conflict(snapshot.groupId);
    }

    for (const settlement of snapshot.settlements) this.insertSettlement(settlement);
    return Result.ok();
  }

  private insertSettlement(settlement: ISettlementSnapshot): void {
    this.database.connection
      .prepare(
        'INSERT INTO settlements (id, group_id, payer, payee, amount, method, status, at, recorded_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(recorded_seq), 0) + 1 FROM settlements))',
      )
      .run(
        settlement._id,
        settlement.groupId,
        settlement.from,
        settlement.to,
        settlement.amount,
        'cash',
        'paid',
        settlement.at,
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
