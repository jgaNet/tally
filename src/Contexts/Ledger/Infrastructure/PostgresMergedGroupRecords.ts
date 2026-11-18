import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { IMergedGroupRecords } from '@Contexts/Ledger/Application/Ports/IMergedGroupRecords';

/**
 * Ledger's tables of a merged group, moved over PostgreSQL (request 31, docs/adr/0031). The audit entries and the receipts change their
 * group and keep their rows; the budgets and the split templates of the group merged are removed. Its methods run inside a transaction:
 * the reaction's.
 */
export class PostgresMergedGroupRecords implements IMergedGroupRecords {
  constructor(private readonly database: PostgresDatabase) {}

  async moveGroup(fromGroupId: string, intoGroupId: string): Promise<void> {
    this.database.assertInTransaction();
    await this.database.run('UPDATE audit_entries SET group_id = ? WHERE group_id = ?', [intoGroupId, fromGroupId]);
    await this.database.run('UPDATE receipts SET group_id = ? WHERE group_id = ?', [intoGroupId, fromGroupId]);
    await this.database.run('DELETE FROM budgets WHERE group_id = ?', [fromGroupId]);
    await this.database.run('DELETE FROM split_templates WHERE group_id = ?', [fromGroupId]);
  }
}
