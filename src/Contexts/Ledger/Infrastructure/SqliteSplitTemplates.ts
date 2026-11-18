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
 * The split templates in PostgreSQL (request 25): the repository the template use cases load and write, and the read side `GetGroupTemplates`
 * reads. A template and its lines are written in one transaction; a save or a removal is conditional on the version it was read at
 * (CONC-OPTIMISTIC), the check and the write one transaction. The name is unique in its group by its key, whatever its case, and the templates
 * are read in the order they were saved: `seq` only grows, and an update keeps it.
 */
export class SqliteSplitTemplates implements ISplitTemplateRepository, ISplitTemplateQueries {
  constructor(private readonly database: LedgerDatabase) {}

  async get(id: string): Promise<SplitTemplate | undefined> {
    const row = await this.database.row<TemplateRow>(
      'SELECT id, group_id, name, split_kind, saved_by, version FROM ledger_split_templates WHERE id = $1',
      [id],
    );
    if (!row) return undefined;
    return SplitTemplate.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      split: await this.#splitOf(row.id, row.split_kind),
      savedBy: row.saved_by,
      version: row.version,
    });
  }

  async isNameTaken(groupId: string, name: string, exceptId?: string): Promise<boolean> {
    const row = await this.database.row<{ id: string }>(
      'SELECT id FROM ledger_split_templates WHERE group_id = $1 AND name_key = $2',
      [groupId, templateNameKeyOf(name)],
    );
    return row !== undefined && row.id !== exceptId;
  }

  async insert(template: SplitTemplate): Promise<void> {
    const { id, groupId, name, split, savedBy, version } = template.toSnapshot();
    await this.database.transaction(async () => {
      await this.database.execute(
        'INSERT INTO ledger_split_templates (id, group_id, name, name_key, split_kind, saved_by, version) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, groupId, name, templateNameKeyOf(name), split.kind, savedBy, version + 1],
      );
      await this.#writeLines(id, split);
    });
  }

  async save(template: SplitTemplate): Promise<void> {
    const { id, name, split, version } = template.toSnapshot();
    await this.database.transaction(async () => {
      await this.#checkVersion(id, version);
      await this.database.execute(
        'UPDATE ledger_split_templates SET name = $1, name_key = $2, split_kind = $3, version = $4 WHERE id = $5',
        [name, templateNameKeyOf(name), split.kind, version + 1, id],
      );
      await this.#deleteLines(id);
      await this.#writeLines(id, split);
    });
  }

  async remove(template: SplitTemplate): Promise<void> {
    const { id, version } = template.toSnapshot();
    await this.database.transaction(async () => {
      await this.#checkVersion(id, version);
      await this.#deleteLines(id);
      await this.database.execute('DELETE FROM ledger_split_templates WHERE id = $1', [id]);
    });
  }

  inTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.database.transaction(work);
  }

  async templatesOf(groupId: string): Promise<TemplateView[]> {
    const rows = await this.database.rows<{
      id: string;
      group_id: string;
      name: string;
      split_kind: 'equal' | 'shares';
    }>('SELECT id, group_id, name, split_kind FROM ledger_split_templates WHERE group_id = $1 ORDER BY seq', [groupId]);
    return Promise.all(
      rows.map(async row => {
        const split = await this.#splitOf(row.id, row.split_kind);
        const base = { id: row.id, groupId: row.group_id, name: row.name };
        return split.kind === 'equal'
          ? { ...base, splitBetween: [...split.memberIds] }
          : { ...base, splitByShares: split.shares.map(line => ({ memberId: line.memberId, shares: line.shares })) };
      }),
    );
  }

  async #checkVersion(id: string, version: number): Promise<void> {
    const stored = await this.database.row<{ version: number }>(
      'SELECT version FROM ledger_split_templates WHERE id = $1',
      [id],
    );
    if (!stored || stored.version !== version) {
      throw new ConcurrencyConflictException('Ledger', 'The split template changed since it was read');
    }
  }

  async #splitOf(id: string, kind: 'equal' | 'shares'): Promise<TemplateSplit> {
    const lines = await this.database.rows<LineRow>(
      'SELECT member_id, shares FROM ledger_split_template_lines WHERE template_id = $1 ORDER BY position',
      [id],
    );
    if (kind === 'equal') return { kind: 'equal', memberIds: lines.map(line => line.member_id) };
    return { kind: 'shares', shares: lines.map(line => ({ memberId: line.member_id, shares: line.shares ?? 0 })) };
  }

  async #writeLines(id: string, split: TemplateSplit): Promise<void> {
    if (split.kind === 'equal') {
      for (const [position, memberId] of split.memberIds.entries()) {
        await this.#writeLine(id, position, memberId, null);
      }
    } else {
      for (const [position, line] of split.shares.entries()) {
        await this.#writeLine(id, position, line.memberId, line.shares);
      }
    }
  }

  async #writeLine(id: string, position: number, memberId: string, shares: number | null): Promise<void> {
    await this.database.execute(
      'INSERT INTO ledger_split_template_lines (template_id, position, member_id, shares) VALUES ($1, $2, $3, $4)',
      [id, position, memberId, shares],
    );
  }

  async #deleteLines(id: string): Promise<void> {
    await this.database.execute('DELETE FROM ledger_split_template_lines WHERE template_id = $1', [id]);
  }
}
