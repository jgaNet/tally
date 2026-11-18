import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { TemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';
import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';
import { createLedgerTables } from '@Contexts/Ledger/Infrastructure/LedgerTables';

interface Row {
  id: string;
  group_id: string;
  name: string;
  created_by: string;
  split_kind: 'equal' | 'shares';
  version: number;
}

interface MemberRow {
  member_id: string;
  shares: number | null;
}

/**
 * The split templates, in the application's file. It runs inside the command's transaction, which holds the file, so it takes no lock
 * of its own. A save that finds the template at another version than it was read at is a conflict, and its transaction is rolled back
 * with it.
 */
export class SqliteSplitTemplateRepository implements ISplitTemplateRepository {
  constructor(private database: SqliteDatabase) {
    createLedgerTables(database);
  }

  async findById(id: Id): Promise<SplitTemplate | null> {
    const row = this.database.get<Row>(
      'SELECT id, group_id, name, created_by, split_kind, version FROM split_templates WHERE id = ?',
      id.value,
    );
    if (!row) return null;
    const members = this.database.all<MemberRow>(
      'SELECT member_id, shares FROM split_template_members WHERE template_id = ? ORDER BY position',
      id.value,
    );
    return SplitTemplate.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      createdBy: row.created_by,
      split: splitOf(row.split_kind, members),
      version: row.version,
    });
  }

  async nameTaken(groupId: Id, name: string, except: Id | null): Promise<boolean> {
    const row = this.database.get<{ id: string }>(
      'SELECT id FROM split_templates WHERE group_id = ? AND name_key = ? AND id != ?',
      groupId.value,
      TemplateName.keyOf(name),
      except?.value ?? '',
    );
    return Boolean(row);
  }

  async save(template: SplitTemplate): Promise<IResult> {
    const { id, groupId, name, createdBy, split, version } = template.toSnapshot();
    if (version === 0) {
      this.database.run(
        `INSERT INTO split_templates (id, group_id, name, name_key, created_by, split_kind, version, saved_seq)
         VALUES (?, ?, ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(saved_seq), 0) + 1 FROM split_templates))`,
        id,
        groupId,
        name,
        TemplateName.keyOf(name),
        createdBy,
        split.kind,
      );
    } else {
      const changed = this.database.run(
        'UPDATE split_templates SET name = ?, name_key = ?, split_kind = ?, version = ? WHERE id = ? AND version = ?',
        name,
        TemplateName.keyOf(name),
        split.kind,
        version + 1,
        id,
        version,
      );
      if (!changed) {
        return Result.fail(new ConcurrencyConflictException('Ledger', 'The template has changed', { id }));
      }
      this.database.run('DELETE FROM split_template_members WHERE template_id = ?', id);
    }
    membersRows(split).forEach((member, position) =>
      this.database.run(
        'INSERT INTO split_template_members (template_id, position, member_id, shares) VALUES (?, ?, ?, ?)',
        id,
        position,
        member.memberId,
        member.shares,
      ),
    );
    return Result.ok();
  }

  async remove(template: SplitTemplate): Promise<IResult> {
    const { id, version } = template.toSnapshot();
    const removed = this.database.run('DELETE FROM split_templates WHERE id = ? AND version = ?', id, version);
    if (!removed) {
      return Result.fail(new ConcurrencyConflictException('Ledger', 'The template has changed', { id }));
    }
    this.database.run('DELETE FROM split_template_members WHERE template_id = ?', id);
    return Result.ok();
  }
}

/** The members of a split as rows, in the order given: a split by shares keeps each member's shares, an equal one keeps none. */
function membersRows(split: TemplateSplit): { memberId: string; shares: number | null }[] {
  return split.kind === 'equal'
    ? split.members.map(memberId => ({ memberId, shares: null }))
    : split.shares.map(share => ({ memberId: share.memberId, shares: share.shares }));
}

function splitOf(kind: 'equal' | 'shares', rows: MemberRow[]): TemplateSplit {
  return kind === 'equal'
    ? { kind, members: rows.map(row => row.member_id) }
    : { kind, shares: rows.map(row => ({ memberId: row.member_id, shares: row.shares ?? 0 })) };
}
