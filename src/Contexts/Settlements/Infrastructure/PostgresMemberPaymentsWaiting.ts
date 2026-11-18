import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IMemberPaymentsWaiting } from '@Contexts/Settlements/Domain/Settlement/Ports/IMemberPaymentsWaiting';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/**
 * Whether a member has a provider payment waiting in a group (ADR 13): one it pays or receives that is pending or refunding.
 * Read inside the asking command's transaction, on the connection it holds, so that a leave sees the payments decided before
 * it, and a payment decided after it finds the member gone.
 */
export class PostgresMemberPaymentsWaiting implements IMemberPaymentsWaiting {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  async hasWaitingPayment(groupId: string, memberId: string): Promise<boolean> {
    const row = await this.database.connection.row<{ found: number }>(
      `SELECT 1 AS found FROM settlements
        WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding')
          AND (payer_id = ? OR payee_id = ?)
        LIMIT 1`,
      groupId,
      memberId,
      memberId,
    );
    return row !== undefined;
  }
}
