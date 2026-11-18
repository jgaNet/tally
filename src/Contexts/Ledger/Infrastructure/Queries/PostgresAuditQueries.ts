import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { AuditEntry, AuditAction } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { IAuditQueries } from '@Contexts/Ledger/Domain/Audit/Ports/IAuditQueries';

interface AuditRow {
  id: string;
  group_id: string;
  at: string;
  by_account: string;
  action: AuditAction;
  subject_id: string;
  amount: number;
}

/** The audit entries of Ledger's changes, read from the table the expense repository writes (request 28). */
export class PostgresAuditQueries implements IAuditQueries {
  constructor(private database: PostgresDatabase) {}

  async entriesOf(groupId: string): Promise<AuditEntry[]> {
    const rows = await this.database.all<AuditRow>('SELECT * FROM audit_entries WHERE group_id = ? ORDER BY seq', [
      groupId,
    ]);
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
}
