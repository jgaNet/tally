import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ISettlementAuditLog } from '@Contexts/Settlements/Application/Ports/ISettlementAuditLog';
import {
  ISettlementAuditQueries,
  SettlementAuditEntry,
} from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditQueries';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

interface AuditRow {
  id: string;
  at: string;
  by_account: string;
  action: 'settlement-paid' | 'settlement-refunded';
  subject_id: string;
  amount: number;
}

/**
 * The settlements' audit, in the application's file (request 28). `record` writes inside the command's transaction, which holds the
 * file, so it takes no lock; `entriesOf` is read outside any transaction and waits for the one in progress.
 */
export class PostgresSettlementAuditLog implements ISettlementAuditLog, ISettlementAuditQueries {
  constructor(private database: PostgresDatabase) {
    createSettlementsTables(database);
  }

  async record(groupId: string, entry: SettlementAuditEntry): Promise<void> {
    await this.database.run(
      'INSERT INTO settlement_audit_entries (id, group_id, at, by_account, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entry.id,
      groupId,
      entry.at,
      entry.by,
      entry.action,
      entry.subjectId,
      entry.amount,
    );
  }

  async entriesOf(groupId: string): Promise<SettlementAuditEntry[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<AuditRow>(
          'SELECT id, at, by_account, action, subject_id, amount FROM settlement_audit_entries WHERE group_id = ? ORDER BY at, seq',
          groupId,
        )
      ).map(row => ({
        id: row.id,
        at: row.at,
        by: row.by_account,
        action: row.action,
        subjectId: row.subject_id,
        amount: row.amount,
      })),
    );
  }
}
