import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import {
  SettledMember,
  SettlementStatus,
  SettlementStatusLine,
  SettlementWithHistory,
  WaitingMember,
} from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import {
  prepareSettlementSchema,
  SettlementRow,
  settlementView,
} from '@Contexts/Settlements/Infrastructure/SqliteSettlementBooks';

type HistoryRow = { settlement_id: string; status: string; learned_at: string };

const lineOf = (row: HistoryRow): SettlementStatusLine => ({
  status: String(row.status) as SettlementStatus,
  at: String(row.learned_at),
});

/** The settlement with the statuses it has had, the earliest first (request 19). */
const withHistory = (row: SettlementRow, lines: SettlementStatusLine[]): SettlementWithHistory => ({
  ...settlementView(row),
  history: lines,
});

/**
 * What each member paid and received over the settlements of a group that have one of the given statuses, in one statement
 * (docs/adr/0013, docs/adr/0015).
 */
function totalsOf(
  database: SqliteDatabase,
  groupId: string,
  statuses: readonly string[],
): Array<{ memberId: string; paid: number; received: number }> {
  // One statement, so one snapshot: what each member paid and what they received, over the group's settlements of those statuses.
  const marks = statuses.map(() => '?').join(', ');
  const rows = database.connection
    .prepare(
      `SELECT member_id, SUM(paid) AS paid, SUM(received) AS received FROM (
         SELECT payer_id AS member_id, amount AS paid, 0 AS received FROM settlements WHERE group_id = ? AND status IN (${marks})
         UNION ALL
         SELECT payee_id, 0, amount FROM settlements WHERE group_id = ? AND status IN (${marks})
       ) GROUP BY member_id`,
    )
    .all(groupId, ...statuses, groupId, ...statuses) as Array<{ member_id: string; paid: number; received: number }>;
  return rows.map(row => ({ memberId: String(row.member_id), paid: Number(row.paid), received: Number(row.received) }));
}

/** The read side of the settlements over SQLite: reads of the file, taken alone, outside any transaction (docs/adr/0013, docs/adr/0014). */
export class SqliteSettlementQueries implements ISettlementQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareSettlementSchema);
  }

  async findSettlement(settlementId: string): Promise<SettlementWithHistory | undefined> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const row = connection
        .prepare(
          'SELECT id, group_id, payer_id, payee_id, amount, method, status, recorded_at, pay_url FROM settlements WHERE id = ?',
        )
        .get(settlementId) as SettlementRow | undefined;
      if (!row) return undefined;
      const lines = connection
        .prepare(
          'SELECT settlement_id, status, learned_at FROM settlement_statuses WHERE settlement_id = ? ORDER BY rowid',
        )
        .all(settlementId) as HistoryRow[];
      return withHistory(row, lines.map(lineOf));
    });
  }

  /**
   * Every settlement of the group, the most recently recorded first, each with its statuses in one statement for the group (request 19).
   * Two recorded at the same moment are told apart by the order they were stored in: the one stored later comes first.
   */
  async listSettlementsOf(groupId: string): Promise<SettlementWithHistory[]> {
    return this.database.exclusive(() => {
      const connection = this.database.connection;
      const rows = connection
        .prepare(
          'SELECT id, group_id, payer_id, payee_id, amount, method, status, recorded_at, pay_url FROM settlements WHERE group_id = ? ORDER BY recorded_at DESC, rowid DESC',
        )
        .all(groupId) as SettlementRow[];
      const lines = connection
        .prepare(
          'SELECT l.settlement_id, l.status, l.learned_at FROM settlement_statuses l JOIN settlements s ON s.id = l.settlement_id WHERE s.group_id = ? ORDER BY l.rowid',
        )
        .all(groupId) as HistoryRow[];
      const byId = new Map<string, SettlementStatusLine[]>();
      for (const line of lines) {
        const id = String(line.settlement_id);
        byId.set(id, [...(byId.get(id) ?? []), lineOf(line)]);
      }
      return rows.map(row => withHistory(row, byId.get(String(row.id)) ?? []));
    });
  }

  /**
   * The settlements of the group that count: the paid ones, and those refunding, whose money has not gone back yet. A pending, failed or
   * refunded one is not counted (requests 13, 15).
   */
  async settledOf(groupId: string): Promise<SettledMember[]> {
    return this.database.exclusive(() =>
      totalsOf(this.database, groupId, ['paid', 'refunding']).map((member): SettledMember => ({ ...member })),
    );
  }

  async providerWaitingOf(groupId: string, memberId: string): Promise<boolean> {
    return this.database.exclusive(
      () =>
        this.database.connection
          .prepare(
            "SELECT 1 FROM settlements WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding') AND (payer_id = ? OR payee_id = ?) LIMIT 1",
          )
          .get(groupId, memberId, memberId) !== undefined,
    );
  }

  async waitingOf(groupId: string): Promise<WaitingMember[]> {
    return this.database.exclusive(() =>
      totalsOf(this.database, groupId, ['pending']).map((member): WaitingMember => ({ ...member })),
    );
  }
}
