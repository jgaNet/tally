import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import {
  ISettlementAuditEntries,
  SettlementAuditRow,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditEntries';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/**
 * The changes of money of a group's settlements, read from their history (request 28, request 33). The history is written in the
 * transaction of each change, so an entry is there when its change is, and it is never changed:
 * - a `paid` status is `settlement-paid`, by the payee of a settlement in cash (who recorded it), by the member who asked for a
 *   netting (request 32) for one made by it, and by the payer of one through the provider (who paid it); a `paid` after a contest
 *   is by the administrator who decided it was paid (request 33, ADR 24);
 * - a `contested` status is `settlement-contested`, by the payee who contested it (request 33);
 * - a `refunded` status is `settlement-refunded`, by the payee who asked for it, and only for a settlement that counted: one
 *   refunded from `pending` changed no balance, so it has no entry.
 * A settlement annulled by an administrator has no entry: the balances stopped counting it when it was contested.
 */
export class PostgresSettlementAuditEntries implements ISettlementAuditEntries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async entriesOf(groupId: string): Promise<SettlementAuditRow[]> {
    const rows = await this.database.exclusive(connection =>
      connection.rows<{
        seq: number;
        status: 'paid' | 'refunded' | 'contested';
        at: string;
        subjectId: string;
        method: 'cash' | 'provider' | 'net';
        payer: string;
        payee: string;
        asker: string | null;
        decider: string | null;
        afterContest: boolean;
        amount: number;
      }>(
        `SELECT h.id AS seq, h.status, h.at, s.id AS "subjectId", s.method, s.payer_id AS payer, s.payee_id AS payee, COALESCE(s.settled, s.amount) AS amount,
                (SELECT n.by_id FROM netting_settlements ns JOIN nettings n ON n.id = ns.netting_id
                  WHERE ns.settlement_id = s.id) AS asker,
                (SELECT d.by_id FROM administrator_decisions d
                  WHERE d.subject_id = s.id AND d.action = 'decided-paid' AND d.at = h.at) AS decider,
                EXISTS (SELECT 1 FROM settlement_history c
                         WHERE c.settlement_id = h.settlement_id AND c.status = 'contested' AND c.id < h.id) AS "afterContest"
           FROM settlement_history h JOIN settlements s ON s.id = h.settlement_id
          WHERE s.group_id = ? AND h.status IN ('paid', 'refunded', 'contested')
            AND (h.status <> 'refunded' OR EXISTS (SELECT 1 FROM settlement_history p
                                                    WHERE p.settlement_id = h.settlement_id AND p.status = 'paid'))
          ORDER BY h.at, h.id`,
        groupId,
      ),
    );
    return rows.map((row): SettlementAuditRow => {
      const base = { id: '', at: row.at, subjectId: row.subjectId, amount: Number(row.amount) };
      if (row.status === 'contested') {
        return { ...base, id: `settlement-contested:${row.seq}`, by: row.payee, action: 'settlement-contested' };
      }
      if (row.status === 'refunded') {
        return { ...base, id: `settlement-refunded:${row.seq}`, by: row.payee, action: 'settlement-refunded' };
      }
      if (row.afterContest) {
        return { ...base, id: `settlement-paid:${row.seq}`, by: row.decider ?? row.payer, action: 'settlement-paid' };
      }
      const by = row.method === 'cash' ? row.payee : row.method === 'net' ? (row.asker ?? row.payer) : row.payer;
      return { ...base, id: `settlement-paid:${row.seq}`, by, action: 'settlement-paid' };
    });
  }
}
