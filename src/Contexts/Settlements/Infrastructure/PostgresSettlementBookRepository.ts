import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
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

/** The books' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresSettlementBookRepository implements ISettlementBookRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async findByGroup(groupId: Id): Promise<SettlementBook> {
    const { connection } = this.database;
    const row = await connection.row<{ version: number }>(
      'SELECT version FROM settlement_books WHERE group_id = ?',
      groupId.value,
    );
    const rows = await connection.rows<SettlementRow>(
      'SELECT * FROM settlements WHERE group_id = ? ORDER BY recorded_at, rowid',
      groupId.value,
    );
    const history = await connection.rows<HistoryRow>(
      `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
       JOIN settlements s ON s.id = h.settlement_id
       WHERE s.group_id = ? ORDER BY h.id`,
      groupId.value,
    );
    return SettlementBook.open(
      groupId,
      row ? Number(row.version) : 0,
      rows.map(row => toSettlement(row, historyOf(history, row.id))),
    );
  }

  async findByPaymentId(paymentId: string): Promise<SettlementBook | null> {
    const row = await this.database.connection.row<{ group_id: string }>(
      'SELECT group_id FROM settlements WHERE provider_payment_id = ?',
      paymentId,
    );
    return row ? this.findByGroup(new Id(row.group_id)) : null;
  }

  async findBySettlement(settlementId: Id): Promise<SettlementBook | null> {
    const row = await this.database.connection.row<{ group_id: string }>(
      'SELECT group_id FROM settlements WHERE id = ?',
      settlementId.value,
    );
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
      const { changes } = await connection.run(
        'INSERT INTO settlement_books (group_id, version) VALUES (?, 1) ON CONFLICT DO NOTHING',
        groupId,
      );
      if (changes === 0) return conflict();
    } else {
      const { changes } = await connection.run(
        'UPDATE settlement_books SET version = version + 1 WHERE group_id = ? AND version = ?',
        groupId,
        book.version,
      );
      if (changes === 0) return conflict();
    }

    for (const settlement of book.unsaved) {
      await connection.run(
        `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, recorded_at, provider_payment_id, pay_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status`,
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
      await connection.run(
        'INSERT INTO settlement_history (settlement_id, status, at) VALUES (?, ?, ?)',
        change.settlementId.value,
        change.status,
        change.at.toISOString(),
      );
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
