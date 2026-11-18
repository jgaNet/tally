import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IAdministratorDecisionLog } from '@Contexts/Settlements/Application/Ports/IAdministratorDecisionLog';
import {
  AdministratorDecisionEntry,
  IAdministratorDecisionQueries,
} from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorDecisionQueries';
import { createSettlementsTables } from '@Contexts/Settlements/Infrastructure/SettlementsTables';

interface DecisionRow {
  id: string;
  at: string;
  by_account: string;
  action: AdministratorDecisionEntry['action'];
  subject_id: string;
}

/**
 * The administrators' log, in the application's file (request 33). `record` writes inside the decision's transaction, which holds the file,
 * so it takes no lock; `entries` is read outside any transaction and waits for the one in progress.
 */
export class PostgresAdministratorDecisionLog implements IAdministratorDecisionLog, IAdministratorDecisionQueries {
  constructor(private database: PostgresDatabase) {
    createSettlementsTables(database);
  }

  async record(entry: AdministratorDecisionEntry): Promise<void> {
    await this.database.run(
      'INSERT INTO settlement_administrator_decisions (id, at, by_account, action, subject_id) VALUES (?, ?, ?, ?, ?)',
      entry.id,
      entry.at,
      entry.by,
      entry.action,
      entry.subjectId,
    );
  }

  async entries(): Promise<AdministratorDecisionEntry[]> {
    return this.database.exclusive(async () =>
      (
        await this.database.all<DecisionRow>(
          'SELECT id, at, by_account, action, subject_id FROM settlement_administrator_decisions ORDER BY seq',
        )
      ).map(row => ({
        id: row.id,
        at: row.at,
        by: row.by_account,
        action: row.action,
        subjectId: row.subject_id,
      })),
    );
  }
}
