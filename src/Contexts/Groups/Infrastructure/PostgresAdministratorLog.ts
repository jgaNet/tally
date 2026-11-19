import { Id } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { AdministratorLogEntry, IAdministratorLog } from '@Contexts/Groups/Application/Ports/IAdministratorLog';
import { ACCOUNT_STATEMENTS } from '@Contexts/Groups/Infrastructure/accounts.schema';

/**
 * Groups' own administrators' log (request 34, ADR 25): written in the transaction of the change it records, read outside any
 * transaction, the oldest first.
 */
export class PostgresAdministratorLog implements IAdministratorLog {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(ACCOUNT_STATEMENTS);
  }

  async record(entry: Omit<AdministratorLogEntry, 'id'>): Promise<void> {
    await this.database.connection.run(
      'INSERT INTO account_administration_log (id, at, by_id, action, subject_id) VALUES (?, ?, ?, ?, ?)',
      Id.generate().value,
      entry.at,
      entry.by,
      entry.action,
      entry.subjectId,
    );
  }

  entries(): Promise<AdministratorLogEntry[]> {
    return this.database.exclusive(connection =>
      connection.rows<AdministratorLogEntry>(
        `SELECT id, at, by_id AS "by", action, subject_id AS "subjectId"
           FROM account_administration_log ORDER BY at, seq`,
      ),
    );
  }
}
