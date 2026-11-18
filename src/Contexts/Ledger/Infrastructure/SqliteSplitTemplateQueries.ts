import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
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

/** What the screens read of the templates, from the SQLite file, outside any transaction: the earliest saved first. */
export class SqliteSplitTemplateQueries implements ISplitTemplateQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SPLIT_TEMPLATE_STATEMENTS);
  }

  listByGroup(groupId: string): Promise<SplitTemplateReadModel[]> {
    return this.database.exclusive(connection => {
      const rows = connection
        .prepare('SELECT id, group_id, name, kind FROM ledger_split_templates WHERE group_id = ? ORDER BY rowid')
        .all(groupId) as unknown as TemplateRow[];
      const members = connection.prepare(
        'SELECT member_id, shares FROM ledger_split_template_members WHERE template_id = ? ORDER BY position',
      );
      return rows.map((row): SplitTemplateReadModel => {
        const listed = members.all(row.id) as unknown as MemberRow[];
        const base = { id: row.id, groupId: row.group_id, name: row.name };
        return row.kind === 'between'
          ? { ...base, splitBetween: listed.map(member => member.member_id) }
          : {
              ...base,
              splitByShares: listed.map(member => ({ memberId: member.member_id, shares: member.shares })),
            };
      });
    });
  }
}
