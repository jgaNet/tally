import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import {
  ISettlementAuditEntries,
  SettlementAuditRow,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditEntries';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/**
 * The changes of money of a group's settlements, read from their history (request 28). The history is written in the
 * transaction of each change, so an entry is there when its change is, and it is never changed:
 * - a `paid` status is `settlement-paid`, by the payee of a settlement in cash (who recorded it), by the member who asked for a
 *   netting (request 32) for one made by it, and by the payer of one through the provider (who paid it);
 * - a `refunded` status is `settlement-refunded`, by the payee who asked for it, and only for a settlement that counted: one
 *   refunded from `pending` changed no balance, so it has no entry.
 */
export class PostgresSettlementAuditEntries implements ISettlementAuditEntries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async entriesOf(groupId: string): Promise<SettlementAuditRow[]> {
    const rows = await this.database.exclusive(connection =>
      connection.rows<{
        seq: number;
        status: 'paid' | 'refunded';
        at: string;
        subjectId: string;
        method: 'cash' | 'provider' | 'net';
        payer: string;
        payee: string;
        asker: string | null;
        amount: number;
      }>(
        `SELECT h.id AS seq, h.status, h.at, s.id AS "subjectId", s.method, s.payer_id AS payer, s.payee_id AS payee, s.amount,
                (SELECT n.by_id FROM netting_settlements ns JOIN nettings n ON n.id = ns.netting_id
                  WHERE ns.settlement_id = s.id) AS asker
           FROM settlement_history h JOIN settlements s ON s.id = h.settlement_id
          WHERE s.group_id = ? AND h.status IN ('paid', 'refunded')
            AND (h.status = 'paid' OR EXISTS (SELECT 1 FROM settlement_history p
                                               WHERE p.settlement_id = h.settlement_id AND p.status = 'paid'))
          ORDER BY h.at, h.id`,
        groupId,
      ),
    );
    return rows.map(row =>
      row.status === 'paid'
        ? {
            id: `settlement-paid:${row.seq}`,
            at: row.at,
            by: row.method === 'cash' ? row.payee : row.method === 'net' ? (row.asker ?? row.payer) : row.payer,
            action: 'settlement-paid' as const,
            subjectId: row.subjectId,
            amount: Number(row.amount),
          }
        : {
            id: `settlement-refunded:${row.seq}`,
            at: row.at,
            by: row.payee,
            action: 'settlement-refunded' as const,
            subjectId: row.subjectId,
            amount: Number(row.amount),
          },
    );
  }
}
