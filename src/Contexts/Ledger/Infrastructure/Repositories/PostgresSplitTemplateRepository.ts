import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { ISplitTemplateSnapshot } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import { SplitTemplate, TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { DuplicateTemplateNameException } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/**
 * The table of split templates (request 25): one row per template, its split kept as it was given, and its version. A name is unique
 * in its group by its key, the name in lower case, so that two names differing in case are one name. `seq` is the order the
 * templates were saved in: a change of a template's name or split keeps its row, and so its place in the list.
 * Declared with the database, which makes it when it opens (ADR 20).
 */
export function defineSplitTemplateTables(database: PostgresDatabase): void {
  database.define(`
    CREATE TABLE IF NOT EXISTS split_templates (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      split TEXT NOT NULL,
      saved_by TEXT NOT NULL,
      version INTEGER NOT NULL,
      seq BIGSERIAL NOT NULL,
      UNIQUE (group_id, name_key)
    );
  `);
}

interface SplitTemplateRow {
  id: string;
  group_id: string;
  name: string;
  split: string;
  saved_by: string;
  version: number;
}

/** The key a name is unique by in its group: the name in lower case. */
export const nameKeyOf = (name: string): string => name.toLowerCase();

/** The split templates as aggregates, over the application's PostgreSQL database, inside the transaction of the command. */
export class PostgresSplitTemplateRepository implements ISplitTemplateRepository {
  constructor(private database: PostgresDatabase) {
    defineSplitTemplateTables(database);
  }

  async findById(id: string): Promise<SplitTemplate | null> {
    const row = await this.database.get<SplitTemplateRow>('SELECT * FROM split_templates WHERE id = ?', [id]);
    return row ? SplitTemplate.fromSnapshot(snapshotOf(row)) : null;
  }

  async findByName(groupId: string, name: string): Promise<SplitTemplate | null> {
    const row = await this.database.get<SplitTemplateRow>(
      'SELECT * FROM split_templates WHERE group_id = ? AND name_key = ?',
      [groupId, nameKeyOf(name)],
    );
    return row ? SplitTemplate.fromSnapshot(snapshotOf(row)) : null;
  }

  /**
   * A new template is inserted at version 1; one read at a version is updated only where the row is still at it, as SQL makes the
   * check atomic. A name another template of the group has is a DuplicateTemplateNameException, whether the template is new or changed.
   * A changed name is checked before the update, not by the constraint's error: a failed statement would abort the transaction.
   */
  async save(template: SplitTemplate): Promise<IResult> {
    const snapshot = template.toSnapshot();
    const key = nameKeyOf(snapshot.name);
    const split = JSON.stringify(snapshot.split);

    if (snapshot.version === 0) {
      const inserted = await this.database.run(
        'INSERT INTO split_templates (id, group_id, name, name_key, split, saved_by, version) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING',
        [snapshot._id, snapshot.groupId, snapshot.name, key, split, snapshot.savedBy],
      );
      if (inserted.changes === 0) return Result.fail(new DuplicateTemplateNameException());
      return Result.ok();
    }

    const sameName = await this.database.get(
      'SELECT 1 FROM split_templates WHERE group_id = ? AND name_key = ? AND id <> ?',
      [snapshot.groupId, key, snapshot._id],
    );
    if (sameName) return Result.fail(new DuplicateTemplateNameException());

    const updated = await this.database.run(
      'UPDATE split_templates SET name = ?, name_key = ?, split = ?, version = ? WHERE id = ? AND version = ?',
      [snapshot.name, key, split, snapshot.version + 1, snapshot._id, snapshot.version],
    );
    if (updated.changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The template changed since it was read', { id: snapshot._id }),
      );
    }
    return Result.ok();
  }

  /** Erases a template at the version it was read at; a template no longer at it is refused as a conflict. */
  async erase(template: SplitTemplate): Promise<IResult> {
    const snapshot = template.toSnapshot();
    const deleted = await this.database.run('DELETE FROM split_templates WHERE id = ? AND version = ?', [
      snapshot._id,
      snapshot.version,
    ]);
    if (deleted.changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Ledger', 'The template changed since it was read', { id: snapshot._id }),
      );
    }
    return Result.ok();
  }
}

const snapshotOf = (row: SplitTemplateRow): ISplitTemplateSnapshot => ({
  _id: row.id,
  groupId: row.group_id,
  name: row.name,
  split: JSON.parse(row.split) as TemplateSplit,
  savedBy: row.saved_by,
  version: row.version,
});
