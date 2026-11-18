import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { SplitTemplateView } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import { ISplitTemplateQueries } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateQueries';
import {
  SPLIT_TEMPLATE_COLUMNS,
  SplitTemplateRow,
  prepareSplitTemplateSchema,
  splitTemplateSnapshotOf,
} from '@Contexts/Ledger/Infrastructure/PostgresSplitTemplates';

/** The read side of the split templates over PostgreSQL: reads taken alone, outside any transaction (request 25). */
export class PostgresSplitTemplateQueries implements ISplitTemplateQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareSplitTemplateSchema);
  }

  async listOf(groupId: string): Promise<SplitTemplateView[]> {
    return this.database.exclusive(async () => {
      const rows = await this.database.all<SplitTemplateRow>(
        `SELECT ${SPLIT_TEMPLATE_COLUMNS} FROM split_templates WHERE group_id = ? ORDER BY seq`,
        [groupId],
      );
      return rows.map((row): SplitTemplateView => {
        const { id, groupId: group, name, split } = splitTemplateSnapshotOf(row);
        return split.kind === 'equal'
          ? { id, groupId: group, name, splitBetween: split.between }
          : { id, groupId: group, name, splitByShares: split.shares };
      });
    });
  }
}
