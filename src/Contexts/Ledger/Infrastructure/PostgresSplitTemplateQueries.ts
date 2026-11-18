import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { ISplitTemplateQueries } from '@Contexts/Ledger/Application/Ports/ISplitTemplateQueries';
import { SplitTemplateReadModel } from '@Contexts/Ledger/Application/ReadModel/SplitTemplateReadModel';
import { SPLIT_TEMPLATE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/splitTemplates.schema';

interface TemplateRow {
  id: string;
  group_id: string;
  name: string;
  kind: 'between' | 'shares';
}

interface MemberRow {
  member_id: string;
  shares: number;
}

/** What the screens read of the templates, from the PostgreSQL database, outside any transaction: the earliest saved first. */
export class PostgresSplitTemplateQueries implements ISplitTemplateQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SPLIT_TEMPLATE_STATEMENTS);
  }

  listByGroup(groupId: string): Promise<SplitTemplateReadModel[]> {
    return this.database.exclusive(async connection => {
      const rows = await connection.rows<TemplateRow>(
        'SELECT id, group_id, name, kind FROM ledger_split_templates WHERE group_id = ? ORDER BY rowid',
        groupId,
      );
      const templates: SplitTemplateReadModel[] = [];
      for (const row of rows) {
        const listed = await connection.rows<MemberRow>(
          'SELECT member_id, shares FROM ledger_split_template_members WHERE template_id = ? ORDER BY position',
          row.id,
        );
        const base = { id: row.id, groupId: row.group_id, name: row.name };
        templates.push(
          row.kind === 'between'
            ? { ...base, splitBetween: listed.map(member => member.member_id) }
            : {
                ...base,
                splitByShares: listed.map(member => ({ memberId: member.member_id, shares: member.shares })),
              },
        );
      }
      return templates;
    });
  }
}
