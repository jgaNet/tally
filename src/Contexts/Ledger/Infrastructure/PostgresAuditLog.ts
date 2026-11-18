import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IAuditLog } from '@Contexts/Ledger/Application/Ports/IAuditLog';
import { IAuditQueries } from '@Contexts/Ledger/Application/Ports/IAuditQueries';
import { AuditAction, AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface AuditRow {
  id: string;
  at: string;
  by_account: string;
  action: AuditAction;
  subject_id: string;
  amount: number;
}

/**
 * The expenses' audit, in the application's file (request 28). `record` writes inside the command's transaction, which holds the file,
 * so it takes no lock; `entriesOf` is read outside any transaction and waits for the one in progress.
 */
export class PostgresAuditLog implements IAuditLog, IAuditQueries {
  constructor(private database: PostgresDatabase) {
    createLedgerTables(database);
  }

  async record(groupId: string, entry: AuditEntryReadModel): Promise<void> {
    await this.database.run(
      'INSERT INTO audit_entries (id, group_id, at, by_account, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entry.id,
      groupId,
      entry.at,
      entry.by,
      entry.action,
      entry.subjectId,
      entry.amount,
    );
  }

  async entriesOf(groupId: string): Promise<AuditEntryReadModel[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<AuditRow>(
          'SELECT id, at, by_account, action, subject_id, amount FROM audit_entries WHERE group_id = ? ORDER BY at, seq',
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
