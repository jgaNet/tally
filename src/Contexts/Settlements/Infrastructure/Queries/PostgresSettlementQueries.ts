import { AuditEntry } from '@Contexts/Settlements/Domain/Settlement/AuditEntry';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import {
  createSettlementTables,
  SettlementRow,
} from '@Contexts/Settlements/Infrastructure/Repositories/PostgresSettlementBookRepository';
import { AdminLogEntry, FeeBorneBy, SettlementStatus } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import {
  CountedSettlement,
  ISettlementQueries,
  OpenProviderPayment,
  PaidSettlement,
  SettlementView,
  WaitingSettlement,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/** A status line as the table keeps it, with the id of the settlement it belongs to. */
interface HistoryRow {
  settlement_id: string;
  status: SettlementStatus;
  at: string;
}

/** The settlements read model over the application's database: each settlement as it stands, with its history (request 19). */
export class PostgresSettlementQueries implements ISettlementQueries {
  constructor(private database: PostgresDatabase) {
    createSettlementTables(database);
  }

  async findById(id: string): Promise<SettlementView | null> {
    const row = await this.database.get<SettlementRow>('SELECT * FROM settlements WHERE id = ?', [id]);
    if (!row) return null;

    const lines = await this.database.all<HistoryRow>(
      'SELECT settlement_id, status, at FROM settlement_history WHERE settlement_id = ? ORDER BY seq',
      [id],
    );
    return viewOf(row, lines);
  }

  async listGroupSettlements(groupId: string): Promise<SettlementView[]> {
    const rows = await this.database.all<SettlementRow>(
      'SELECT * FROM settlements WHERE group_id = ? ORDER BY recorded_seq DESC',
      [groupId],
    );
    const lines = await this.database.all<HistoryRow>(
      `SELECT h.settlement_id, h.status, h.at FROM settlement_history h
         JOIN settlements s ON s.id = h.settlement_id
        WHERE s.group_id = ?
        ORDER BY h.seq`,
      [groupId],
    );

    const byId = new Map<string, HistoryRow[]>();
    for (const line of lines) {
      const list = byId.get(line.settlement_id) ?? [];
      list.push(line);
      byId.set(line.settlement_id, list);
    }
    return rows.map(row => viewOf(row, byId.get(row.id) ?? []));
  }

  async auditOf(groupId: string): Promise<AuditEntry[]> {
    const rows = await this.database.all<{
      id: string;
      group_id: string;
      at: string;
      by_account: string;
      action: AuditEntry['action'];
      subject_id: string;
      amount: number;
    }>(
      'SELECT id, group_id, at, by_account, action, subject_id, amount FROM settlement_audit WHERE group_id = ? ORDER BY seq',
      [groupId],
    );
    return rows.map(row => ({
      id: row.id,
      groupId: row.group_id,
      at: row.at,
      by: row.by_account,
      action: row.action,
      subjectId: row.subject_id,
      amount: row.amount,
    }));
  }

  async paidIn(groupId: string): Promise<PaidSettlement[]> {
    const rows = await this.database.all<{ payer: string; payee: string; settled: number }>(
      `SELECT payer, payee, COALESCE(settled_amount, amount) AS settled FROM settlements
        WHERE group_id = ? AND status IN ('paid', 'refunding') ORDER BY recorded_seq`,
      [groupId],
    );
    return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.settled }));
  }

  async feePolicyOf(groupId: string): Promise<FeeBorneBy> {
    const row = await this.database.get<{ fee_borne_by: FeeBorneBy }>(
      'SELECT fee_borne_by FROM settlement_books WHERE group_id = ?',
      [groupId],
    );
    return row ? row.fee_borne_by : 'payee';
  }

  async countedIn(groupId: string): Promise<CountedSettlement[]> {
    const rows = await this.database.all<{
      id: string;
      payer: string;
      payee: string;
      amount: number;
      method: 'cash' | 'provider' | 'net';
      counted_at: string;
    }>(
      `SELECT s.id, s.payer, s.payee, COALESCE(s.settled_amount, s.amount) AS amount, s.method,
              COALESCE((SELECT h.at FROM settlement_history h
                         WHERE h.settlement_id = s.id AND h.status = 'paid' ORDER BY h.seq LIMIT 1), s.at) AS counted_at
         FROM settlements s
        WHERE s.group_id = ? AND s.status IN ('paid', 'refunding')
        ORDER BY s.recorded_seq`,
      [groupId],
    );
    return rows.map(row => ({
      id: row.id,
      from: row.payer,
      to: row.payee,
      amount: row.amount,
      method: row.method,
      countedAt: row.counted_at,
    }));
  }

  async contested(): Promise<SettlementView[]> {
    const rows = await this.database.all<SettlementRow>(
      `SELECT s.* FROM settlements s
        WHERE s.status = 'contested'
        ORDER BY (SELECT MAX(h.seq) FROM settlement_history h WHERE h.settlement_id = s.id AND h.status = 'contested')`,
    );
    const views: SettlementView[] = [];
    for (const row of rows) views.push((await this.findById(row.id))!);
    return views;
  }

  async adminLog(): Promise<AdminLogEntry[]> {
    const rows = await this.database.all<{
      id: string;
      at: string;
      by_account: string;
      action: AdminLogEntry['action'];
      subject_id: string;
    }>('SELECT id, at, by_account, action, subject_id FROM settlement_admin_log ORDER BY seq');
    return rows.map(row => ({
      id: row.id,
      at: row.at,
      by: row.by_account,
      action: row.action,
      subjectId: row.subject_id,
    }));
  }

  async openProviderPaymentsIn(groupId: string): Promise<OpenProviderPayment[]> {
    const rows = await this.database.all<{ payer: string; payee: string }>(
      "SELECT payer, payee FROM settlements WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'contested', 'refunding') ORDER BY recorded_seq",
      [groupId],
    );
    return rows.map(row => ({ from: row.payer, to: row.payee }));
  }

  async openProviderPaymentsOf(accountId: string): Promise<OpenProviderPayment[]> {
    const rows = await this.database.all<{ payer: string; payee: string }>(
      "SELECT payer, payee FROM settlements WHERE method = 'provider' AND status IN ('pending', 'contested', 'refunding') AND (payer = ? OR payee = ?) ORDER BY recorded_seq",
      [accountId, accountId],
    );
    return rows.map(row => ({ from: row.payer, to: row.payee }));
  }

  async waitingIn(groupId: string): Promise<WaitingSettlement[]> {
    const rows = await this.database.all<{ payer: string; payee: string; settled: number }>(
      `SELECT payer, payee, COALESCE(settled_amount, amount) AS settled FROM settlements
        WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'contested') ORDER BY recorded_seq`,
      [groupId],
    );
    return rows.map(row => ({ from: row.payer, to: row.payee, amount: row.settled }));
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
  if (row.fee_borne_by && row.fee_amount !== null) {
    view.fee = { amount: row.fee_amount, borneBy: row.fee_borne_by };
  }
  if (row.original_currency && row.original_amount !== null && row.original_rate) {
    view.original = { currency: row.original_currency, amount: row.original_amount, rate: row.original_rate };
  }
  return view;
}
