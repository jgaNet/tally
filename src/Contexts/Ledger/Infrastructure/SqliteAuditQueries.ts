import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IAuditQueries } from '@Contexts/Ledger/Application/Ports/IAuditQueries';
import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';
import { AUDIT_STATEMENTS } from '@Contexts/Ledger/Infrastructure/audit.schema';

/** The expenses' entries of a group's audit, from the SQLite file, outside any transaction (request 28). */
export class SqliteAuditQueries implements IAuditQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(AUDIT_STATEMENTS);
  }

  listByGroup(groupId: string): Promise<AuditEntryReadModel[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare(
          `SELECT id, at, by_id AS by, action, subject_id AS subjectId, amount
             FROM ledger_audit_entries WHERE group_id = ? ORDER BY at, rowid`,
        )
        .all(groupId) as unknown as AuditEntryReadModel[];
      return rows.map(row => ({ ...row, amount: Number(row.amount) }));
    });
  }
}
