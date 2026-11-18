import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ITemplateQueries } from '@Contexts/Ledger/Application/Ports/ITemplateQueries';
import { TemplateReadModel } from '@Contexts/Ledger/Application/ReadModel/TemplateReadModel';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface Row {
  id: string;
  group_id: string;
  name: string;
  split_kind: 'equal' | 'shares';
}

interface MemberRow {
  member_id: string;
  shares: number | null;
}

/**
 * The templates of a group, read in the order they were saved, each with the split it was given (request 25). It is read outside any
 * transaction, so it waits for the one in progress, as the budgets' read models do.
 */
export class PostgresSplitTemplateReadModels implements ITemplateQueries {
  constructor(private database: PostgresDatabase) {
    createLedgerTables(database);
  }

  async ofGroup(groupId: string): Promise<TemplateReadModel[]> {
    return this.database.exclusive(async () => {
      const rows = await this.database.all<Row>(
        'SELECT id, group_id, name, split_kind FROM split_templates WHERE group_id = ? ORDER BY saved_seq',
        groupId,
      );
      const templates: TemplateReadModel[] = [];
      for (const row of rows) {
        const members = await this.database.all<MemberRow>(
          'SELECT member_id, shares FROM split_template_members WHERE template_id = ? ORDER BY position',
          row.id,
        );
        const base = { id: row.id, groupId: row.group_id, name: row.name };
        templates.push(
          row.split_kind === 'equal'
            ? { ...base, splitBetween: members.map(member => member.member_id) }
            : {
                ...base,
                splitByShares: members.map(member => ({ memberId: member.member_id, shares: member.shares ?? 0 })),
              },
        );
      }
      return templates;
    });
  }
}
