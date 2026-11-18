import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplateQueries, TemplateView } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateQueries';
import { createSplitTemplateTables } from '@Contexts/Ledger/Infrastructure/Repositories/SqliteSplitTemplateRepository';

/**
 * The read side of split templates over the application's SQLite file (request 25). A template is listed in the order it was
 * saved: SQLite's row order, which a change of its name or split keeps, since the row is updated in place.
 */
export class SqliteSplitTemplateQueries implements ISplitTemplateQueries {
  constructor(private database: SqliteDatabase) {
    createSplitTemplateTables(database);
  }

  async listGroupTemplates(groupId: string): Promise<TemplateView[]> {
    const rows = this.database.connection
      .prepare('SELECT id, group_id, name, split FROM split_templates WHERE group_id = ? ORDER BY rowid')
      .all(groupId) as { id: string; group_id: string; name: string; split: string }[];

    return rows.map(row => {
      const split = JSON.parse(row.split) as TemplateSplit;
      const base = { id: row.id, groupId: row.group_id, name: row.name };
      return split.kind === 'equal'
        ? { ...base, splitBetween: split.memberIds }
        : { ...base, splitByShares: split.shares };
    });
  }
}
