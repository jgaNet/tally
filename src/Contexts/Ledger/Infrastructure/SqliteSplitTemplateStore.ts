import { ConcurrencyConflictException } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISplitTemplateStore, TemplateView } from '@Contexts/Ledger/Application/ISplitTemplateStore';
import {
  SplitTemplate,
  SplitTemplateSnapshot,
  TemplateKind,
  TemplateMember,
  templateNameKey,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';

/**
 * The split templates' tables (request 25, ADR 20). `split_templates` is one row per template: its name and the name's key (the name whatever
 * its case, unique per group), who saved it, how it splits, and the version it is stored at. `split_template_members` is one row per member of a
 * template's split, by position, so that the split is read as it was given. Created by `CREATE TABLE IF NOT EXISTS`, as every table here.
 */
export const splitTemplatesTablesSchema = [
  `CREATE TABLE IF NOT EXISTS split_templates (
     id TEXT PRIMARY KEY,
     group_id TEXT NOT NULL REFERENCES groups(id),
     name TEXT NOT NULL,
     name_key TEXT NOT NULL,
     saved_by TEXT NOT NULL,
     split_kind TEXT NOT NULL CHECK (split_kind IN ('equal', 'shares')),
     version INTEGER NOT NULL,
     UNIQUE (group_id, name_key)
   )`,
  `CREATE TABLE IF NOT EXISTS split_template_members (
     template_id TEXT NOT NULL REFERENCES split_templates(id),
     position INTEGER NOT NULL,
     member_id TEXT NOT NULL,
     shares INTEGER NOT NULL,
     PRIMARY KEY (template_id, position)
   )`,
];

interface TemplateRow {
  id: string;
  group_id: string;
  name: string;
  saved_by: string;
  split_kind: TemplateKind;
  version: number;
}

interface MemberRow {
  member_id: string;
  shares: number;
}

const CONFLICT = 'The template changed since it was read, or another template has this name: read it again';

/**
 * The split templates in SQLite. `add`, `save` and `remove` write inside the command's transaction; `save` and `remove` only while the template
 * is still at the version it was loaded at (the optimistic check, ADR 8). A name taken by another template, found only when the unique key
 * refuses a write, is a conflict of the same kind, so the command re-reads and decides again.
 */
export class SqliteSplitTemplateStore implements ISplitTemplateStore {
  constructor(private readonly database: SqliteDatabase) {}

  async findById(templateId: string): Promise<SplitTemplate | undefined> {
    const row = this.database.writer
      .prepare('SELECT id, group_id, name, saved_by, split_kind, version FROM split_templates WHERE id = ?')
      .get(templateId) as unknown as TemplateRow | undefined;
    if (!row) return undefined;
    return SplitTemplate.fromSnapshot(this.#snapshotOf(row, this.#membersOf(row.id)));
  }

  async nameHeldBy(groupId: string, name: string): Promise<string | undefined> {
    const row = this.database.writer
      .prepare('SELECT id FROM split_templates WHERE group_id = ? AND name_key = ?')
      .get(groupId, templateNameKey(name)) as unknown as { id: string } | undefined;
    return row?.id;
  }

  async add(template: SplitTemplate): Promise<void> {
    const snapshot = template.toSnapshot();
    try {
      this.database.writer
        .prepare(
          'INSERT INTO split_templates (id, group_id, name, name_key, saved_by, split_kind, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          snapshot.id,
          snapshot.groupId,
          snapshot.name,
          templateNameKey(snapshot.name),
          snapshot.savedBy,
          snapshot.kind,
          snapshot.version + 1,
        );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConcurrencyConflictException('Ledger', CONFLICT);
      throw error;
    }
    this.#writeMembers(snapshot.id, snapshot.members);
  }

  async save(template: SplitTemplate): Promise<void> {
    const snapshot = template.toSnapshot();
    let changes: number | bigint;
    try {
      ({ changes } = this.database.writer
        .prepare(
          'UPDATE split_templates SET name = ?, name_key = ?, split_kind = ?, version = ? WHERE id = ? AND version = ?',
        )
        .run(
          snapshot.name,
          templateNameKey(snapshot.name),
          snapshot.kind,
          snapshot.version + 1,
          snapshot.id,
          snapshot.version,
        ));
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConcurrencyConflictException('Ledger', CONFLICT);
      throw error;
    }
    if (changes === 0) throw new ConcurrencyConflictException('Ledger', CONFLICT);

    this.database.writer.prepare('DELETE FROM split_template_members WHERE template_id = ?').run(snapshot.id);
    this.#writeMembers(snapshot.id, snapshot.members);
  }

  async remove(template: SplitTemplate): Promise<void> {
    const snapshot = template.toSnapshot();
    this.database.writer.prepare('DELETE FROM split_template_members WHERE template_id = ?').run(snapshot.id);
    const { changes } = this.database.writer
      .prepare('DELETE FROM split_templates WHERE id = ? AND version = ?')
      .run(snapshot.id, snapshot.version);
    if (changes === 0) throw new ConcurrencyConflictException('Ledger', CONFLICT);
  }

  async listOf(groupId: string): Promise<TemplateView[]> {
    return this.database.read(db => {
      const rows = db
        .prepare('SELECT id, group_id, name, split_kind FROM split_templates WHERE group_id = ? ORDER BY rowid')
        .all(groupId) as unknown as { id: string; group_id: string; name: string; split_kind: TemplateKind }[];
      return rows.map((row): TemplateView => {
        const members = (
          db
            .prepare('SELECT member_id, shares FROM split_template_members WHERE template_id = ? ORDER BY position')
            .all(row.id) as unknown as MemberRow[]
        ).map(member => ({ memberId: member.member_id, shares: member.shares }));
        const base = { id: row.id, groupId: row.group_id, name: row.name };
        return row.split_kind === 'equal'
          ? { ...base, splitBetween: members.map(member => member.memberId) }
          : { ...base, splitByShares: members.map(member => ({ memberId: member.memberId, shares: member.shares })) };
      });
    }) as TemplateView[];
  }

  #membersOf(templateId: string): TemplateMember[] {
    const rows = this.database.writer
      .prepare('SELECT member_id, shares FROM split_template_members WHERE template_id = ? ORDER BY position')
      .all(templateId) as unknown as MemberRow[];
    return rows.map(row => ({ memberId: row.member_id, shares: row.shares }));
  }

  #snapshotOf(row: TemplateRow, members: TemplateMember[]): SplitTemplateSnapshot {
    return {
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      savedBy: row.saved_by,
      kind: row.split_kind,
      members,
      version: row.version,
    };
  }

  #writeMembers(templateId: string, members: readonly TemplateMember[]): void {
    members.forEach((member, position) => {
      this.database.writer
        .prepare('INSERT INTO split_template_members (template_id, position, member_id, shares) VALUES (?, ?, ?, ?)')
        .run(templateId, position, member.memberId, member.shares);
    });
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && error.message.includes('UNIQUE constraint failed');
