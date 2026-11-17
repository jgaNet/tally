import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { ISettlementQueries } from '@Contexts/Settlements/Application/Ports/ISettlementQueries';
import { SettlementReadModel } from '@Contexts/Settlements/Application/ReadModel/SettlementReadModel';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

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
}

interface HistoryRow {
  settlement_id: string;
  status: SettlementReadModel['status'];
  at: string;
}

/** What the screens read of a settlement, from the SQLite file, outside any transaction. */
export class SqliteSettlementQueries implements ISettlementQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  findById(id: string): Promise<SettlementReadModel | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT * FROM settlements WHERE id = ?').get(id) as SettlementRow | undefined;
      if (!row) return null;
      const history = connection
        .prepare('SELECT settlement_id, status, at FROM settlement_history WHERE settlement_id = ? ORDER BY id')
        .all(id) as unknown as HistoryRow[];
      return toReadModel(row, history);
    });
  }

  findByGroup(groupId: string): Promise<SettlementReadModel[]> {
    return this.database.exclusive(connection => {
      // The most recently recorded first; a tie is broken by the order the rows were stored in.
      const rows = connection
        .prepare('SELECT * FROM settlements WHERE group_id = ? ORDER BY recorded_at DESC, rowid DESC')
        .all(groupId) as unknown as SettlementRow[];
      const history = connection
        .prepare(
          `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
           JOIN settlements s ON s.id = h.settlement_id
           WHERE s.group_id = ? ORDER BY h.id`,
        )
        .all(groupId) as unknown as HistoryRow[];
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
  };
}
