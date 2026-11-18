import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplateQueries, TemplateView } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateQueries';
import { defineSplitTemplateTables } from '@Contexts/Ledger/Infrastructure/Repositories/PostgresSplitTemplateRepository';

/**
 * The read side of split templates over the application's PostgreSQL database (request 25). A template is listed in the order
 * it was saved: its `seq`, which a change of its name or split keeps, since the row is updated in place.
 */
export class PostgresSplitTemplateQueries implements ISplitTemplateQueries {
  constructor(private database: PostgresDatabase) {
    defineSplitTemplateTables(database);
  }

  async listGroupTemplates(groupId: string): Promise<TemplateView[]> {
    const rows = await this.database.all<{ id: string; group_id: string; name: string; split: string }>(
      'SELECT id, group_id, name, split FROM split_templates WHERE group_id = ? ORDER BY seq',
      [groupId],
    );

    return rows.map(row => {
      const split = JSON.parse(row.split) as TemplateSplit;
      const base = { id: row.id, groupId: row.group_id, name: row.name };
      return split.kind === 'equal'
        ? { ...base, splitBetween: split.memberIds }
        : { ...base, splitByShares: split.shares };
    });
  }
}
