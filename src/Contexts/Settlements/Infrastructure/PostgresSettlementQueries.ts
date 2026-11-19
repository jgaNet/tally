import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import {
  AdministratorDecisionEntry,
  CountedSettlement,
  SettledMember,
  SettlementAuditEntry,
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
} from '@Contexts/Settlements/Infrastructure/PostgresSettlementBooks';
import { DEFAULT_FEE_BORNE, FeeBorne } from '@Contexts/Settlements/Domain/Settlement/ProviderFee';

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
async function totalsOf(
  database: PostgresDatabase,
  groupId: string,
  statuses: readonly string[],
): Promise<Array<{ memberId: string; paid: number; received: number }>> {
  // One statement, so one snapshot: what each member paid and what they received, over the group's settlements of those statuses.
  const marks = statuses.map(() => '?').join(', ');
  // What a settlement counts is what it settles, less the part of the provider's fee its payer bears (request 38).
  const rows = await database.all<{ member_id: string; paid: number; received: number }>(
    `SELECT member_id, SUM(paid) AS paid, SUM(received) AS received FROM (
         SELECT payer_id AS member_id, COALESCE(settled, amount) AS paid, 0 AS received FROM settlements WHERE group_id = ? AND status IN (${marks})
         UNION ALL
         SELECT payee_id, 0, COALESCE(settled, amount) FROM settlements WHERE group_id = ? AND status IN (${marks})
       ) totals GROUP BY member_id`,
    [groupId, ...statuses, groupId, ...statuses],
  );
  return rows.map(row => ({ memberId: String(row.member_id), paid: Number(row.paid), received: Number(row.received) }));
}

/** The read side of the settlements over PostgreSQL: reads taken alone, outside any transaction (docs/adr/0013, docs/adr/0014). */
export class PostgresSettlementQueries implements ISettlementQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareSettlementSchema);
  }

  async findSettlement(settlementId: string): Promise<SettlementWithHistory | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<SettlementRow>(
        'SELECT id, group_id, payer_id, payee_id, amount, method, status, recorded_at, pay_url, fee_amount, fee_borne_by, original_currency, original_amount, original_rate FROM settlements WHERE id = ?',
        [settlementId],
      );
      if (!row) return undefined;
      const lines = await this.database.all<HistoryRow>(
        'SELECT settlement_id, status, learned_at FROM settlement_statuses WHERE settlement_id = ? ORDER BY seq',
        [settlementId],
      );
      return withHistory(row, lines.map(lineOf));
    });
  }

  /**
   * Every settlement of the group, the most recently recorded first, each with its statuses in one statement for the group (request 19).
   * Two recorded at the same moment are told apart by the order they were stored in: the one stored later comes first.
   */
  async listSettlementsOf(groupId: string): Promise<SettlementWithHistory[]> {
    return this.database.exclusive(async () => {
      const rows = await this.database.all<SettlementRow>(
        'SELECT id, group_id, payer_id, payee_id, amount, method, status, recorded_at, pay_url, fee_amount, fee_borne_by, original_currency, original_amount, original_rate FROM settlements WHERE group_id = ? ORDER BY recorded_at COLLATE "C" DESC, seq DESC',
        [groupId],
      );
      const lines = await this.database.all<HistoryRow>(
        'SELECT l.settlement_id, l.status, l.learned_at FROM settlement_statuses l JOIN settlements s ON s.id = l.settlement_id WHERE s.group_id = ? ORDER BY l.seq',
        [groupId],
      );
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
    return this.database.exclusive(async () =>
      (await totalsOf(this.database, groupId, ['paid', 'refunding'])).map((member): SettledMember => ({ ...member })),
    );
  }

  async countedOf(groupId: string): Promise<CountedSettlement[]> {
    // One statement, one snapshot. The moment a settlement started to count is the one its 'paid' line was learned at: a cash one has it
    // from its recording, a provider one from the provider's word (docs/adr/0028). Falls back to the recording for a file without the line.
    return this.database.exclusive(async () =>
      (
        await this.database.all<{
          id: string;
          payer_id: string;
          payee_id: string;
          amount: number;
          method: string;
          counted_from: string;
        }>(
          `SELECT s.id, s.payer_id, s.payee_id, COALESCE(s.settled, s.amount) AS amount, s.method,
               COALESCE((SELECT MIN(l.learned_at COLLATE "C") FROM settlement_statuses l WHERE l.settlement_id = s.id AND l.status = 'paid'), s.recorded_at) AS counted_from
             FROM settlements s WHERE s.group_id = ? AND s.status IN ('paid', 'refunding')`,
          [groupId],
        )
      ).map((row): CountedSettlement => ({
        settlementId: String(row.id),
        payerId: String(row.payer_id),
        payeeId: String(row.payee_id),
        amount: Number(row.amount),
        method: String(row.method) as CountedSettlement['method'],
        countedFrom: String(row.counted_from),
      })),
    );
  }

  async providerWaitingOf(groupId: string, memberId: string): Promise<boolean> {
    return this.database.exclusive(
      async () =>
        (await this.database.get(
          "SELECT 1 FROM settlements WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding', 'contested') AND (payer_id = ? OR payee_id = ?) LIMIT 1",
          [groupId, memberId, memberId],
        )) !== undefined,
    );
  }

  async providerWaitingOfAccount(memberId: string): Promise<boolean> {
    return this.database.exclusive(
      async () =>
        (await this.database.get(
          "SELECT 1 FROM settlements WHERE method = 'provider' AND status IN ('pending', 'refunding', 'contested') AND (payer_id = ? OR payee_id = ?) LIMIT 1",
          [memberId, memberId],
        )) !== undefined,
    );
  }

  /** What each member is waiting to pay and receive: the pending settlements, and the contested ones, which count as paid (request 33). */
  async waitingOf(groupId: string): Promise<WaitingMember[]> {
    return this.database.exclusive(async () =>
      (await totalsOf(this.database, groupId, ['pending', 'contested'])).map((member): WaitingMember => ({
        ...member,
      })),
    );
  }

  /** The settlements contested now, the earliest contested first, each with its history in one statement for them (request 33). */
  async contestedSettlements(): Promise<SettlementWithHistory[]> {
    return this.database.exclusive(async () => {
      const rows = await this.database.all<SettlementRow>(
        `SELECT s.id, s.group_id, s.payer_id, s.payee_id, s.amount, s.method, s.status, s.recorded_at, s.pay_url, s.fee_amount, s.fee_borne_by, s.original_currency, s.original_amount, s.original_rate FROM settlements s
           WHERE s.status = 'contested'
           ORDER BY (SELECT MIN(l.learned_at COLLATE "C") FROM settlement_statuses l WHERE l.settlement_id = s.id AND l.status = 'contested') COLLATE "C", s.seq`,
        [],
      );
      const lines = await this.database.all<HistoryRow>(
        "SELECT l.settlement_id, l.status, l.learned_at FROM settlement_statuses l JOIN settlements s ON s.id = l.settlement_id WHERE s.status = 'contested' ORDER BY l.seq",
        [],
      );
      const byId = new Map<string, SettlementStatusLine[]>();
      for (const line of lines) {
        const id = String(line.settlement_id);
        byId.set(id, [...(byId.get(id) ?? []), lineOf(line)]);
      }
      return rows.map(row => withHistory(row, byId.get(String(row.id)) ?? []));
    });
  }

  /** The administrators' decisions, the oldest first, as the log keeps them (request 33, docs/adr/0033). */
  async administratorDecisions(): Promise<AdministratorDecisionEntry[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<{ id: string; at: string; by_id: string; action: string; subject_id: string }>(
          'SELECT id, at, by_id, action, subject_id FROM administrator_decisions ORDER BY seq',
          [],
        )
      ).map((row): AdministratorDecisionEntry => ({
        id: String(row.id),
        at: String(row.at),
        by: String(row.by_id),
        action: String(row.action) as AdministratorDecisionEntry['action'],
        subjectId: String(row.subject_id),
      })),
    );
  }

  /** Who bears the provider's fee in the group: the owner's decision, or the payee's until it is made (request 38). */
  async feePolicyOf(groupId: string): Promise<FeeBorne> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<{ fee_borne_by: string | null }>(
        'SELECT fee_borne_by FROM settlement_books WHERE group_id = ?',
        [groupId],
      );
      return row?.fee_borne_by ? (String(row.fee_borne_by) as FeeBorne) : DEFAULT_FEE_BORNE;
    });
  }

  async auditOf(groupId: string): Promise<SettlementAuditEntry[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<{
          id: string;
          at: string;
          by_id: string;
          action: string;
          subject_id: string;
          amount: number;
        }>(
          'SELECT id, at, by_id, action, subject_id, amount FROM settlement_audit WHERE group_id = ? ORDER BY at COLLATE "C", seq',
          [groupId],
        )
      ).map((row): SettlementAuditEntry => ({
        id: String(row.id),
        at: String(row.at),
        by: String(row.by_id),
        action: String(row.action) as SettlementAuditEntry['action'],
        subjectId: String(row.subject_id),
        amount: Number(row.amount),
      })),
    );
  }
}
