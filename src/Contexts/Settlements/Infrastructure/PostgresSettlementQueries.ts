import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';
import type { FeeBearer } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import type { FeePolicyReadModel } from '@Contexts/Settlements/Application/ReadModel/FeePolicyReadModel';

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: SettlementReadModel['method'];
  status: SettlementReadModel['status'];
  recorded_at: string;
  pay_url: string | null;
  fee_amount: number | null;
  fee_borne_by: FeeBearer | null;
  original_currency: string | null;
  original_amount: number | null;
  original_rate: string | null;
}

interface HistoryRow {
  settlement_id: string;
  status: SettlementReadModel['status'];
  at: string;
}

/** What the screens read of a settlement, from the PostgreSQL database, outside any transaction. */
export class PostgresSettlementQueries implements ISettlementQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  findById(id: string): Promise<SettlementReadModel | null> {
    return this.database.exclusive(async connection => {
      const row = await connection.row<SettlementRow>('SELECT * FROM settlements WHERE id = ?', id);
      if (!row) return null;
      const history = await connection.rows<HistoryRow>(
        'SELECT settlement_id, status, at FROM settlement_history WHERE settlement_id = ? ORDER BY id',
        id,
      );
      return toReadModel(row, history);
    });
  }

  /** Who bears the provider's fee of the group, as its owner decided it: the payee until then (request 38). */
  findFeePolicy(groupId: string): Promise<FeePolicyReadModel> {
    return this.database.exclusive(async connection => {
      const row = await connection.row<{ fee_borne_by: FeeBearer }>(
        'SELECT fee_borne_by FROM settlement_books WHERE group_id = ?',
        groupId,
      );
      return { borneBy: row?.fee_borne_by ?? 'payee' };
    });
  }

  /** The settlements contested now, the earliest contested first: the time each was contested, then the order it was stored in (request 33). */
  findContested(): Promise<SettlementReadModel[]> {
    return this.database.exclusive(async connection => {
      const rows = await connection.rows<SettlementRow>(
        `SELECT s.* FROM settlements s
          WHERE s.status = 'contested'
          ORDER BY (SELECT MIN(h.at) FROM settlement_history h WHERE h.settlement_id = s.id AND h.status = 'contested'), s.rowid`,
      );
      const history = await connection.rows<HistoryRow>(
        `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
         JOIN settlements s ON s.id = h.settlement_id
         WHERE s.status = 'contested' ORDER BY h.id`,
      );
      return rows.map(row => toReadModel(row, history));
    });
  }

  findByGroup(groupId: string): Promise<SettlementReadModel[]> {
    return this.database.exclusive(async connection => {
      // The most recently recorded first; a tie is broken by the order the rows were stored in.
      const rows = await connection.rows<SettlementRow>(
        'SELECT * FROM settlements WHERE group_id = ? ORDER BY recorded_at DESC, rowid DESC',
        groupId,
      );
      const history = await connection.rows<HistoryRow>(
        `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
         JOIN settlements s ON s.id = h.settlement_id
         WHERE s.group_id = ? ORDER BY h.id`,
        groupId,
      );
      return rows.map(row => toReadModel(row, history));
    });
  }
}

/** A settlement as it reads, with its lines of history: the rows of `history` that are its own, the earliest first. */
function toReadModel(row: SettlementRow, history: HistoryRow[]): SettlementReadModel {
  return {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: Number(row.amount),
    method: row.method,
    status: row.status,
    at: row.recorded_at,
    history: history.filter(line => line.settlement_id === row.id).map(line => ({ status: line.status, at: line.at })),
    ...(row.pay_url !== null && { payUrl: row.pay_url }),
    ...(row.fee_borne_by !== null && { fee: { amount: Number(row.fee_amount), borneBy: row.fee_borne_by } }),
    ...(row.original_currency !== null &&
      row.original_amount !== null &&
      row.original_rate !== null && {
        original: { currency: row.original_currency, amount: Number(row.original_amount), rate: row.original_rate },
      }),
  };
}
