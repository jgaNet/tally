import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import {
  AdministratorDecisionRow,
  IAdministratorDecisionEntries,
} from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorDecisionEntries';
import { SETTLEMENT_STATEMENTS } from '@Contexts/Settlements/Infrastructure/settlements.schema';

/**
 * The administrators' log, read from the decisions the book kept in the transaction of each decision (request 33, ADR 24), the
 * oldest first. Read outside any transaction, by the Groups adapter that answers Groups' port.
 */
export class PostgresAdministratorDecisionEntries implements IAdministratorDecisionEntries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SETTLEMENT_STATEMENTS);
  }

  entries(): Promise<AdministratorDecisionRow[]> {
    return this.database.exclusive(connection =>
      connection.rows<AdministratorDecisionRow>(
        `SELECT id, at, by_id AS "by", action, subject_id AS "subjectId"
           FROM administrator_decisions ORDER BY at, seq`,
      ),
    );
  }
}
