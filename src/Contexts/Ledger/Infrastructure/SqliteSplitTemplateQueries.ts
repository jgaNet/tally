import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SplitTemplateView } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import { ISplitTemplateQueries } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateQueries';
import {
  SPLIT_TEMPLATE_COLUMNS,
  SplitTemplateRow,
  prepareSplitTemplateSchema,
  splitTemplateSnapshotOf,
} from '@Contexts/Ledger/Infrastructure/SqliteSplitTemplates';

/** The read side of the split templates over SQLite: reads of the file, taken alone, outside any transaction (request 25). */
export class SqliteSplitTemplateQueries implements ISplitTemplateQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareSplitTemplateSchema);
  }

  async listOf(groupId: string): Promise<SplitTemplateView[]> {
    return this.database.exclusive(() => {
      const rows = this.database.connection
        .prepare(`SELECT ${SPLIT_TEMPLATE_COLUMNS} FROM split_templates WHERE group_id = ? ORDER BY rowid`)
        .all(groupId) as SplitTemplateRow[];
      return rows.map((row): SplitTemplateView => {
        const { id, groupId: group, name, split } = splitTemplateSnapshotOf(row);
        return split.kind === 'equal'
          ? { id, groupId: group, name, splitBetween: split.between }
          : { id, groupId: group, name, splitByShares: split.shares };
      });
    });
  }
}
