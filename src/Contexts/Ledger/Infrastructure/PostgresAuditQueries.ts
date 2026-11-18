import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IAuditQueries } from '@Contexts/Ledger/Application/Ports/IAuditQueries';
import { AuditEntryReadModel } from '@Contexts/Ledger/Application/ReadModel/AuditEntryReadModel';
import { AUDIT_STATEMENTS } from '@Contexts/Ledger/Infrastructure/audit.schema';

/** The expenses' entries of a group's audit, from the PostgreSQL database, outside any transaction (request 28). */
export class PostgresAuditQueries implements IAuditQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(AUDIT_STATEMENTS);
  }

  listByGroup(groupId: string): Promise<AuditEntryReadModel[]> {
    return this.database.exclusive(async connection => {
      const rows = await connection.rows<AuditEntryReadModel>(
        `SELECT id, at, by_id AS "by", action, subject_id AS "subjectId", amount
           FROM ledger_audit_entries WHERE group_id = ? ORDER BY at, rowid`,
        groupId,
      );
      return rows.map(row => ({ ...row, amount: Number(row.amount) }));
    });
  }
}
