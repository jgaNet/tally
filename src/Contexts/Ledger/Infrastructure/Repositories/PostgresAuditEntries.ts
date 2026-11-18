import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IAuditEntries } from '@Contexts/Ledger/Domain/Audit/Ports/IAuditEntries';

/**
 * The audit entries of Ledger over the application's PostgreSQL database: the table the expenses keep (request 28). A merge moves
 * the entries of the group merged to the group kept; the rows are otherwise never changed.
 */
export class PostgresAuditEntries implements IAuditEntries {
  constructor(private database: PostgresDatabase) {}

  async moveGroup(mergedGroupId: string, keptGroupId: string): Promise<void> {
    await this.database.run('UPDATE audit_entries SET group_id = ? WHERE group_id = ?', [keptGroupId, mergedGroupId]);
  }
}
