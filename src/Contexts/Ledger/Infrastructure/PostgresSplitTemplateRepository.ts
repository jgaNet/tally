import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
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

/** The split templates' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresSplitTemplateRepository implements ISplitTemplateRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(SPLIT_TEMPLATE_STATEMENTS);
  }

  async findById(id: Id): Promise<SplitTemplate | null> {
    const row = await this.database.connection.row<TemplateRow>(
      'SELECT * FROM ledger_split_templates WHERE id = ?',
      id.value,
    );
    return row ? this.reconstitute(row) : null;
  }

  async findByName(groupId: Id, name: TemplateName): Promise<SplitTemplate | null> {
    const row = await this.database.connection.row<TemplateRow>(
      'SELECT * FROM ledger_split_templates WHERE group_id = ? AND name_key = ?',
      groupId.value,
      name.key,
    );
    return row ? this.reconstitute(row) : null;
  }

  async save(template: SplitTemplate): Promise<IResult> {
    const { id, groupId, name, savedBy, kind, members, version } = template.toSnapshot();
    const { connection } = this.database;
    const conflict = () =>
      Result.fail(new ConcurrencyConflictException('Ledger', 'The template changed since it was read', { id }));

    if (template.isRemoved) {
      const { changes } = await connection.run(
        'DELETE FROM ledger_split_templates WHERE id = ? AND version = ?',
        id,
        version,
      );
      if (changes === 0) return conflict();
      await connection.run('DELETE FROM ledger_split_template_members WHERE template_id = ?', id);
      return Result.ok();
    }

    if (version === 0) {
      // Nothing inserted: the group has a template of that name already, saved by another request first. The conflict
      // is not a failed statement, which would abort the whole transaction in PostgreSQL.
      const { changes } = await connection.run(
        `INSERT INTO ledger_split_templates (id, group_id, name, name_key, saved_by, kind, version)
         VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`,
        id,
        groupId,
        name,
        nameKeyOf(name),
        savedBy,
        kind,
      );
      if (changes === 0) return Result.fail(new TemplateNameTaken());
    } else {
      // A rename to a name the group has already fails the statement: a savepoint takes it back, and only it, so that the
      // transaction goes on as it did on the SQLite file.
      let changes: number;
      await connection.run('SAVEPOINT ledger_template_rename');
      try {
        ({ changes } = await connection.run(
          `UPDATE ledger_split_templates SET name = ?, name_key = ?, kind = ?, version = version + 1
            WHERE id = ? AND version = ?`,
          name,
          nameKeyOf(name),
          kind,
          id,
          version,
        ));
      } catch (error) {
        await connection.run('ROLLBACK TO SAVEPOINT ledger_template_rename');
        if ((error as { code?: string }).code === '23505') return Result.fail(new TemplateNameTaken());
        throw error;
      }
      await connection.run('RELEASE SAVEPOINT ledger_template_rename');
      if (changes === 0) return conflict();
      await connection.run('DELETE FROM ledger_split_template_members WHERE template_id = ?', id);
    }

    for (const [position, member] of members.entries()) {
      await connection.run(
        'INSERT INTO ledger_split_template_members (template_id, position, member_id, shares) VALUES (?, ?, ?, ?)',
        id,
        position,
        member.memberId,
        member.shares,
      );
    }
    return Result.ok();
  }

  private async reconstitute(row: TemplateRow): Promise<SplitTemplate> {
    const members = await this.database.connection.rows<MemberRow>(
      'SELECT member_id, shares FROM ledger_split_template_members WHERE template_id = ? ORDER BY position',
      row.id,
    );
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
