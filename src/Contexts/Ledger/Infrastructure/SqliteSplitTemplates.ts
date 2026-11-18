import { ConcurrencyConflictException } from '@Architecture/Domain';
import { ISplitTemplateQueries, TemplateView } from '@Contexts/Ledger/Application/ISplitTemplateQueries';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Application/ISplitTemplateRepository';
import { SplitTemplate, TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { templateNameKeyOf } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';

import { LedgerDatabase } from './LedgerDatabase';

type TemplateRow = {
  id: string;
  group_id: string;
  name: string;
  split_kind: 'equal' | 'shares';
  saved_by: string;
  version: number;
};
type LineRow = { member_id: string; shares: number | null };

/**
 * The split templates in SQLite (request 25): the repository the template use cases load and write, and the read side `GetGroupTemplates`
 * reads. A template and its lines are written in one transaction; a save or a removal is conditional on the version it was read at
 * (CONC-OPTIMISTIC), the check and the write one transaction on the file. The name is unique in its group by its key, whatever its case,
 * and the templates are read in the order they were saved: a row's `rowid` only grows, and an update keeps it.
 */
export class SqliteSplitTemplates implements ISplitTemplateRepository, ISplitTemplateQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async get(id: string): Promise<SplitTemplate | undefined> {
    const row = this.database.connection
      .prepare('SELECT id, group_id, name, split_kind, saved_by, version FROM ledger_split_templates WHERE id = ?')
      .get(id) as TemplateRow | undefined;
    if (!row) return undefined;
    return SplitTemplate.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      split: this.#splitOf(row.id, row.split_kind),
      savedBy: row.saved_by,
      version: row.version,
    });
  }

  async isNameTaken(groupId: string, name: string, exceptId?: string): Promise<boolean> {
    const row = this.database.connection
      .prepare('SELECT id FROM ledger_split_templates WHERE group_id = ? AND name_key = ?')
      .get(groupId, templateNameKeyOf(name)) as { id: string } | undefined;
    return row !== undefined && row.id !== exceptId;
  }

  async insert(template: SplitTemplate): Promise<void> {
    const { id, groupId, name, split, savedBy, version } = template.toSnapshot();
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      connection
        .prepare(
          'INSERT INTO ledger_split_templates (id, group_id, name, name_key, split_kind, saved_by, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, groupId, name, templateNameKeyOf(name), split.kind, savedBy, version + 1);
      this.#writeLines(id, split);
    });
  }

  async save(template: SplitTemplate): Promise<void> {
    const { id, name, split, version } = template.toSnapshot();
    const connection = this.database.connection;
    await this.database.file.transaction(() => {
      this.#checkVersion(id, version);
      connection
        .prepare('UPDATE ledger_split_templates SET name = ?, name_key = ?, split_kind = ?, version = ? WHERE id = ?')
        .run(name, templateNameKeyOf(name), split.kind, version + 1, id);
      this.#deleteLines(id);
      this.#writeLines(id, split);
    });
  }

  async remove(template: SplitTemplate): Promise<void> {
    const { id, version } = template.toSnapshot();
    await this.database.file.transaction(() => {
      this.#checkVersion(id, version);
      this.#deleteLines(id);
      this.database.connection.prepare('DELETE FROM ledger_split_templates WHERE id = ?').run(id);
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.file.transaction(work);
  }

  async templatesOf(groupId: string): Promise<TemplateView[]> {
    const rows = this.database.connection
      .prepare('SELECT id, group_id, name, split_kind FROM ledger_split_templates WHERE group_id = ? ORDER BY rowid')
      .all(groupId) as { id: string; group_id: string; name: string; split_kind: 'equal' | 'shares' }[];
    return rows.map(row => {
      const split = this.#splitOf(row.id, row.split_kind);
      const base = { id: row.id, groupId: row.group_id, name: row.name };
      return split.kind === 'equal'
        ? { ...base, splitBetween: [...split.memberIds] }
        : { ...base, splitByShares: split.shares.map(line => ({ memberId: line.memberId, shares: line.shares })) };
    });
  }

  #checkVersion(id: string, version: number): void {
    const stored = this.database.connection
      .prepare('SELECT version FROM ledger_split_templates WHERE id = ?')
      .get(id) as { version: number } | undefined;
    if (!stored || stored.version !== version) {
      throw new ConcurrencyConflictException('Ledger', 'The split template changed since it was read');
    }
  }

  #splitOf(id: string, kind: 'equal' | 'shares'): TemplateSplit {
    const lines = this.database.connection
      .prepare('SELECT member_id, shares FROM ledger_split_template_lines WHERE template_id = ? ORDER BY position')
      .all(id) as LineRow[];
    if (kind === 'equal') return { kind: 'equal', memberIds: lines.map(line => line.member_id) };
    return { kind: 'shares', shares: lines.map(line => ({ memberId: line.member_id, shares: line.shares ?? 0 })) };
  }

  #writeLines(id: string, split: TemplateSplit): void {
    const insert = this.database.connection.prepare(
      'INSERT INTO ledger_split_template_lines (template_id, position, member_id, shares) VALUES (?, ?, ?, ?)',
    );
    if (split.kind === 'equal') {
      split.memberIds.forEach((memberId, position) => insert.run(id, position, memberId, null));
    } else {
      split.shares.forEach((line, position) => insert.run(id, position, line.memberId, line.shares));
    }
  }

  #deleteLines(id: string): void {
    this.database.connection.prepare('DELETE FROM ledger_split_template_lines WHERE template_id = ?').run(id);
  }
}
