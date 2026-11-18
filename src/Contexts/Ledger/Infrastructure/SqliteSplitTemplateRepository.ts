import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { TemplateName, nameKeyOf } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';
import { TemplateNameTaken } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { SPLIT_TEMPLATE_STATEMENTS } from '@Contexts/Ledger/Infrastructure/splitTemplates.schema';

interface TemplateRow {
  id: string;
  group_id: string;
  name: string;
  saved_by: string;
  kind: 'between' | 'shares';
  version: number;
}

interface MemberRow {
  member_id: string;
  shares: number;
}

/** The split templates' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqliteSplitTemplateRepository implements ISplitTemplateRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(SPLIT_TEMPLATE_STATEMENTS);
  }

  async findById(id: Id): Promise<SplitTemplate | null> {
    const row = this.database.connection.prepare('SELECT * FROM ledger_split_templates WHERE id = ?').get(id.value) as
      TemplateRow | undefined;
    return row ? this.reconstitute(row) : null;
  }

  async findByName(groupId: Id, name: TemplateName): Promise<SplitTemplate | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM ledger_split_templates WHERE group_id = ? AND name_key = ?')
      .get(groupId.value, name.key) as TemplateRow | undefined;
    return row ? this.reconstitute(row) : null;
  }

  async save(template: SplitTemplate): Promise<IResult> {
    const { id, groupId, name, savedBy, kind, members, version } = template.toSnapshot();
    const { connection } = this.database;
    const conflict = () =>
      Result.fail(new ConcurrencyConflictException('Ledger', 'The template changed since it was read', { id }));

    if (template.isRemoved) {
      const { changes } = connection
        .prepare('DELETE FROM ledger_split_templates WHERE id = ? AND version = ?')
        .run(id, version);
      if (Number(changes) === 0) return conflict();
      connection.prepare('DELETE FROM ledger_split_template_members WHERE template_id = ?').run(id);
      return Result.ok();
    }

    if (version === 0) {
      try {
        connection
          .prepare(
            `INSERT INTO ledger_split_templates (id, group_id, name, name_key, saved_by, kind, version)
             VALUES (?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(id, groupId, name, nameKeyOf(name), savedBy, kind);
      } catch {
        // The group has a template of that name already, saved by another request first.
        return Result.fail(new TemplateNameTaken());
      }
    } else {
      let changes: number;
      try {
        changes = Number(
          connection
            .prepare(
              `UPDATE ledger_split_templates SET name = ?, name_key = ?, kind = ?, version = version + 1
                WHERE id = ? AND version = ?`,
            )
            .run(name, nameKeyOf(name), kind, id, version).changes,
        );
      } catch {
        return Result.fail(new TemplateNameTaken());
      }
      if (changes === 0) return conflict();
      connection.prepare('DELETE FROM ledger_split_template_members WHERE template_id = ?').run(id);
    }

    const insert = connection.prepare(
      'INSERT INTO ledger_split_template_members (template_id, position, member_id, shares) VALUES (?, ?, ?, ?)',
    );
    members.forEach((member, position) => insert.run(id, position, member.memberId, member.shares));
    return Result.ok();
  }

  private reconstitute(row: TemplateRow): SplitTemplate {
    const members = this.database.connection
      .prepare('SELECT member_id, shares FROM ledger_split_template_members WHERE template_id = ? ORDER BY position')
      .all(row.id) as unknown as MemberRow[];
    return SplitTemplate.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      savedBy: row.saved_by,
      kind: row.kind,
      members: members.map(member => ({ memberId: member.member_id, shares: member.shares })),
      version: row.version,
    });
  }
}
