import type { DatabaseSync } from 'node:sqlite';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';
import {
  CountedSettlement,
  ICountedSettlements,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ICountedSettlements';

/**
 * The settlements of a member that the balances count, read from the settlements and their history (ADR 7, ADR 9): a
 * settlement counts from its first `paid` status, so that is when it counts for the statement, and it counts while it is
 * `paid` or `refunding`. Read outside a transaction for a query, or on the asking command's connection inside its transaction.
 */
export class SqliteCountedSettlements implements ICountedSettlements {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly inCommand: boolean,
  ) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  countedOf(groupId: string, memberId: string): Promise<CountedSettlement[]> {
    const read = (connection: DatabaseSync): CountedSettlement[] => {
      const rows = connection
        .prepare(
          `SELECT s.id AS settlementId, s.payer_id AS payerId, s.payee_id AS payeeId, s.amount, s.method,
                  (SELECT MIN(h.at) FROM settlement_history h WHERE h.settlement_id = s.id AND h.status = 'paid') AS countedFrom
             FROM settlements s
            WHERE s.group_id = ? AND s.status IN ('paid', 'refunding') AND (s.payer_id = ? OR s.payee_id = ?)
            ORDER BY countedFrom, s.rowid`,
        )
        .all(groupId, memberId, memberId) as unknown as (Omit<CountedSettlement, 'amount'> & { amount: number })[];
      return rows.map(row => ({ ...row, amount: Number(row.amount) }));
    };
    return Promise.resolve(this.inCommand ? read(this.database.connection) : this.database.exclusive(read));
  }
}
