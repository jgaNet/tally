import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { ISplitTemplateSnapshot } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import { SplitTemplate, TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { DuplicateTemplateNameException } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/**
 * The table of split templates (request 25): one row per template, its split kept as it was given, and its version. A name is unique
 * in its group by its key, the name in lower case, so that two names differing in case are one name.
 */
export function createSplitTemplateTables(database: SqliteDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS split_templates (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      split TEXT NOT NULL,
      saved_by TEXT NOT NULL,
      version INTEGER NOT NULL,
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

/** The split templates as aggregates, over the application's SQLite file, inside the transaction of the command. */
export class SqliteSplitTemplateRepository implements ISplitTemplateRepository {
  constructor(private database: SqliteDatabase) {
    createSplitTemplateTables(database);
  }

  async findById(id: string): Promise<SplitTemplate | null> {
    const row = this.database.connection.prepare('SELECT * FROM split_templates WHERE id = ?').get(id) as
      SplitTemplateRow | undefined;
    return row ? SplitTemplate.fromSnapshot(snapshotOf(row)) : null;
  }

  async findByName(groupId: string, name: string): Promise<SplitTemplate | null> {
    const row = this.database.connection
      .prepare('SELECT * FROM split_templates WHERE group_id = ? AND name_key = ?')
      .get(groupId, nameKeyOf(name)) as SplitTemplateRow | undefined;
    return row ? SplitTemplate.fromSnapshot(snapshotOf(row)) : null;
  }

  /**
   * A new template is inserted at version 1; one read at a version is updated only where the row is still at it, as SQL makes the
   * check atomic. A name another template of the group has is a DuplicateTemplateNameException, whether the template is new or changed.
   */
  async save(template: SplitTemplate): Promise<IResult> {
    const snapshot = template.toSnapshot();
    const connection = this.database.connection;
    const key = nameKeyOf(snapshot.name);
    const split = JSON.stringify(snapshot.split);

    if (snapshot.version === 0) {
      const inserted = connection
        .prepare(
          'INSERT INTO split_templates (id, group_id, name, name_key, split, saved_by, version) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING',
        )
        .run(snapshot._id, snapshot.groupId, snapshot.name, key, split, snapshot.savedBy);
      if (inserted.changes === 0) return Result.fail(new DuplicateTemplateNameException());
      return Result.ok();
    }

    try {
      const updated = connection
        .prepare(
          'UPDATE split_templates SET name = ?, name_key = ?, split = ?, version = ? WHERE id = ? AND version = ?',
        )
        .run(snapshot.name, key, split, snapshot.version + 1, snapshot._id, snapshot.version);
      if (updated.changes === 0) {
        return Result.fail(
          new ConcurrencyConflictException('Ledger', 'The template changed since it was read', { id: snapshot._id }),
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        return Result.fail(new DuplicateTemplateNameException());
      }
      throw error;
    }
    return Result.ok();
  }

  /** Erases a template at the version it was read at; a template no longer at it is refused as a conflict. */
  async erase(template: SplitTemplate): Promise<IResult> {
    const snapshot = template.toSnapshot();
    const deleted = this.database.connection
      .prepare('DELETE FROM split_templates WHERE id = ? AND version = ?')
      .run(snapshot._id, snapshot.version);
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
