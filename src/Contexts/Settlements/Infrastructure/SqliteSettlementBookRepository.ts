import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import {
  Settlement,
  SettlementBook,
  SettlementStatusLine,
} from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: Settlement['method'];
  status: Settlement['status'];
  recorded_at: string;
  provider_payment_id: string | null;
  pay_url: string | null;
}

/** The books' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqliteSettlementBookRepository implements ISettlementBookRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async findByGroup(groupId: Id): Promise<SettlementBook> {
    const { connection } = this.database;
    const row = connection.prepare('SELECT version FROM settlement_books WHERE group_id = ?').get(groupId.value) as
      { version: number } | undefined;
    const rows = connection
      .prepare('SELECT * FROM settlements WHERE group_id = ? ORDER BY recorded_at, rowid')
      .all(groupId.value) as unknown as SettlementRow[];
    const history = connection
      .prepare(
        `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
         JOIN settlements s ON s.id = h.settlement_id
         WHERE s.group_id = ? ORDER BY h.id`,
      )
      .all(groupId.value) as unknown as HistoryRow[];
    return SettlementBook.open(
      groupId,
      row ? Number(row.version) : 0,
      rows.map(row => toSettlement(row, historyOf(history, row.id))),
    );
  }

  async findByPaymentId(paymentId: string): Promise<SettlementBook | null> {
    const row = this.database.connection
      .prepare('SELECT group_id FROM settlements WHERE provider_payment_id = ?')
      .get(paymentId) as { group_id: string } | undefined;
    return row ? this.findByGroup(new Id(row.group_id)) : null;
  }

  async findBySettlement(settlementId: Id): Promise<SettlementBook | null> {
    const row = this.database.connection
      .prepare('SELECT group_id FROM settlements WHERE id = ?')
      .get(settlementId.value) as { group_id: string } | undefined;
    return row ? this.findByGroup(new Id(row.group_id)) : null;
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

    for (const settlement of book.unsaved) {
      connection
        .prepare(
          `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at, provider_payment_id, pay_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET status = excluded.status`,
        )
        .run(
          settlement.id.value,
          groupId,
          settlement.payer.value,
          settlement.payee.value,
          settlement.amount,
          settlement.method,
          settlement.status,
          settlement.at.toISOString(),
          settlement.providerPaymentId ?? null,
          settlement.payUrl ?? null,
        );
    }
    for (const change of book.unsavedHistory) {
      connection
        .prepare('INSERT INTO settlement_history (settlement_id, status, at) VALUES (?, ?, ?)')
        .run(change.settlementId.value, change.status, change.at.toISOString());
    }
    return Result.ok();
  }
}

interface HistoryRow {
  settlement_id: string;
  status: SettlementStatusLine['status'];
  at: string;
}

/** The lines of one settlement, the earliest first, out of the rows of the group's history. */
function historyOf(rows: HistoryRow[], settlementId: string): SettlementStatusLine[] {
  return rows
    .filter(row => row.settlement_id === settlementId)
    .map(row => ({ status: row.status, at: new Date(row.at) }));
}

function toSettlement(row: SettlementRow, history: SettlementStatusLine[]): Settlement {
  return {
    id: new Id(row.id),
    groupId: new Id(row.group_id),
    payer: new Id(row.payer_id),
    payee: new Id(row.payee_id),
    amount: Number(row.amount),
    method: row.method,
    status: row.status,
    at: new Date(row.recorded_at),
    history,
    ...(row.provider_payment_id !== null && { providerPaymentId: row.provider_payment_id }),
    ...(row.pay_url !== null && { payUrl: row.pay_url }),
  };
}
