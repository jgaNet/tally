import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import {
  ISettlementAuditEntries,
  SettlementAuditRow,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditEntries';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/**
 * The changes of money of a group's settlements, read from their history (request 28). The history is written in the
 * transaction of each change, so an entry is there when its change is, and it is never changed:
 * - a `paid` status is `settlement-paid`, by the payee of a settlement in cash (who recorded it) and by the payer of one through
 *   the provider (who paid it);
 * - a `refunded` status is `settlement-refunded`, by the payee who asked for it, and only for a settlement that counted: one
 *   refunded from `pending` changed no balance, so it has no entry.
 */
export class SqliteSettlementAuditEntries implements ISettlementAuditEntries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  entriesOf(groupId: string): Promise<SettlementAuditRow[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          `SELECT h.id AS seq, h.status, h.at, s.id AS subjectId, s.method, s.payer_id AS payer, s.payee_id AS payee, s.amount
             FROM settlement_history h JOIN settlements s ON s.id = h.settlement_id
            WHERE s.group_id = ? AND h.status IN ('paid', 'refunded')
              AND (h.status = 'paid' OR EXISTS (SELECT 1 FROM settlement_history p
                                                 WHERE p.settlement_id = h.settlement_id AND p.status = 'paid'))
            ORDER BY h.at, h.id`,
        )
        .all(groupId) as unknown as {
        seq: number;
        status: 'paid' | 'refunded';
        at: string;
        subjectId: string;
        method: 'cash' | 'provider';
        payer: string;
        payee: string;
        amount: number;
      }[];
      return rows.map(row =>
        row.status === 'paid'
          ? {
              id: `settlement-paid:${row.seq}`,
              at: row.at,
              by: row.method === 'cash' ? row.payee : row.payer,
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
    });
  }
}
