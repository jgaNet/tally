import { AuditEntry } from '@Contexts/Settlements/Domain/Settlement/AuditEntry';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  createSettlementTables,
  SettlementRow,
} from '@Contexts/Settlements/Infrastructure/Repositories/SqliteSettlementBookRepository';
import { SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  ISettlementQueries,
  OpenProviderPayment,
  PaidSettlement,
  SettlementView,
  WaitingSettlement,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/** A status line as the file keeps it, with the id of the settlement it belongs to. */
interface HistoryRow {
  settlement_id: string;
  status: SettlementStatus;
  at: string;
}

/** The settlements read model over the application's file: each settlement as it stands, with its history (request 19). */
export class SqliteSettlementQueries implements ISettlementQueries {
  constructor(private database: SqliteDatabase) {
    createSettlementTables(database);
  }

  findById(id: string): Promise<SettlementView | null> {
    return this.database.exclusive(connection => {
      const row = connection.prepare('SELECT * FROM settlements WHERE id = ?').get(id) as SettlementRow | undefined;
      if (!row) return null;

      const lines = connection
        .prepare('SELECT settlement_id, status, at FROM settlement_history WHERE settlement_id = ? ORDER BY seq')
        .all(id) as unknown as HistoryRow[];
      return viewOf(row, lines);
    });
  }

  listGroupSettlements(groupId: string): Promise<SettlementView[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare('SELECT * FROM settlements WHERE group_id = ? ORDER BY recorded_seq DESC')
        .all(groupId) as unknown as SettlementRow[];
      const lines = connection
        .prepare(
          `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
             JOIN settlements s ON s.id = h.settlement_id
            WHERE s.group_id = ?
            ORDER BY h.seq`,
        )
        .all(groupId) as unknown as HistoryRow[];

      const byId = new Map<string, HistoryRow[]>();
      for (const line of lines) {
        const list = byId.get(line.settlement_id) ?? [];
        list.push(line);
        byId.set(line.settlement_id, list);
      }
      return rows.map(row => viewOf(row, byId.get(row.id) ?? []));
    });
  }

  auditOf(groupId: string): Promise<AuditEntry[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare('SELECT * FROM settlement_audit WHERE group_id = ? ORDER BY seq')
        .all(groupId) as unknown as {
        id: string;
        group_id: string;
        at: string;
        by_account: string;
        action: AuditEntry['action'];
        subject_id: string;
        amount: number;
      }[];
      return rows.map(row => ({
        id: row.id,
        groupId: row.group_id,
        at: row.at,
        by: row.by_account,
        action: row.action,
        subjectId: row.subject_id,
        amount: row.amount,
      }));
    });
  }

  paidIn(groupId: string): Promise<PaidSettlement[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          "SELECT payer, payee, amount FROM settlements WHERE group_id = ? AND status IN ('paid', 'refunding') ORDER BY recorded_seq",
        )
        .all(groupId) as unknown as { payer: string; payee: string; amount: number }[];
      return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.amount }));
    });
  }

  openProviderPaymentsIn(groupId: string): Promise<OpenProviderPayment[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          "SELECT payer, payee FROM settlements WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding') ORDER BY recorded_seq",
        )
        .all(groupId) as unknown as { payer: string; payee: string }[];
      return rows.map(row => ({ from: row.payer, to: row.payee }));
    });
  }

  waitingIn(groupId: string): Promise<WaitingSettlement[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          "SELECT payer, payee, amount FROM settlements WHERE group_id = ? AND method = 'provider' AND status = 'pending' ORDER BY recorded_seq",
        )
        .all(groupId) as unknown as { payer: string; payee: string; amount: number }[];
      return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.amount }));
    });
  }
}

/** A settlement row and its status lines (earliest first), as a member reads the settlement. */
function viewOf(row: SettlementRow, lines: HistoryRow[]): SettlementView {
  const view: SettlementView = {
    id: row.id,
    groupId: row.group_id,
    from: row.payer,
    to: row.payee,
    amount: row.amount,
    method: row.method,
    status: row.status,
    at: row.at,
    history: lines.map(line => ({ status: line.status, at: line.at })),
  };
  if (row.method === 'provider' && row.pay_url) view.payUrl = row.pay_url;
  return view;
}
