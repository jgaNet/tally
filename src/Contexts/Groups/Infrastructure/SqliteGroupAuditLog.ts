import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { IGroupAuditLog } from '@Contexts/Groups/Application/Ports/IGroupAuditLog';
import { BalancePassedEntry, IGroupAuditQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupAuditQueries';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

interface AuditRow {
  id: string;
  at: string;
  by_account: string;
  subject_id: string;
  amount: number;
}

/**
 * Groups' audit of the balances passed to the owner, in the application's file (request 28). `record` writes inside the leave's
 * transaction, which holds the file, so it takes no lock; `balancesPassedIn` waits for the transaction in progress, as the other reads do.
 */
export class SqliteGroupAuditLog implements IGroupAuditLog, IGroupAuditQueries {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
  }

  async record(groupId: string, entry: BalancePassedEntry): Promise<void> {
    this.database.run(
      'INSERT INTO group_audit_entries (id, group_id, at, by_account, action, subject_id, amount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entry.id,
      groupId,
      entry.at,
      entry.by,
      entry.action,
      entry.subjectId,
      entry.amount,
    );
  }

  async balancesPassedIn(groupId: string): Promise<BalancePassedEntry[]> {
    return this.database.exclusive(() =>
      this.database
        .all<AuditRow>(
          "SELECT id, at, by_account, subject_id, amount FROM group_audit_entries WHERE group_id = ? AND action = 'balance-passed' ORDER BY at, rowid",
          groupId,
        )
        .map(row => ({
          id: row.id,
          at: row.at,
          by: row.by_account,
          action: 'balance-passed' as const,
          subjectId: row.subject_id,
          amount: row.amount,
        })),
    );
  }
}
