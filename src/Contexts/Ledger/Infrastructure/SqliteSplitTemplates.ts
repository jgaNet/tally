import { DatabaseSync } from 'node:sqlite';

import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SplitTemplateSnapshot, TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import { SplitTemplate } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplate';
import { ISplitTemplates } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplates';
import { templateNameKey } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateName';

/**
 * The split templates' table (request 25, docs/adr/0024): one row per template, its name as given and the key its name is unique by in
 * its group, its split as JSON. A template removed leaves no row; the expenses split by it keep their shares, which are their own.
 */
export const SPLIT_TEMPLATE_SCHEMA =
  'CREATE TABLE IF NOT EXISTS split_templates (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, created_by TEXT NOT NULL, split TEXT NOT NULL, version INTEGER NOT NULL, UNIQUE (group_id, name_key))';

/** A template's row, as the store reads it. */
export type SplitTemplateRow = {
  id: string;
  group_id: string;
  name: string;
  created_by: string;
  split: string;
  version: number;
};

/** The columns a template row is read by, in the order `SplitTemplateRow` lists them. */
export const SPLIT_TEMPLATE_COLUMNS = 'id, group_id, name, created_by, split, version';

/** The snapshot a row keeps: the aggregate is read back from it, and checks what it is given. */
export function splitTemplateSnapshotOf(row: SplitTemplateRow): SplitTemplateSnapshot {
  return {
    id: String(row.id),
    groupId: String(row.group_id),
    name: String(row.name),
    createdBy: String(row.created_by),
    split: JSON.parse(String(row.split)) as TemplateSplit,
    version: Number(row.version),
  };
}

/**
 * The split templates' store over SQLite. Its methods run inside a transaction: the use case's. A save or a removal of a template read at
 * a version another writer has moved past changes nothing and answers a conflict (CONC-OPTIMISTIC).
 */
export class SqliteSplitTemplates implements ISplitTemplates {
  constructor(private readonly database: SqliteDatabase) {
    database.prepare(prepareSplitTemplateSchema);
  }

  async get(id: string): Promise<SplitTemplate | undefined> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare(`SELECT ${SPLIT_TEMPLATE_COLUMNS} FROM split_templates WHERE id = ?`)
      .get(id) as SplitTemplateRow | undefined;
    return row ? SplitTemplate.fromSnapshot(splitTemplateSnapshotOf(row)) : undefined;
  }

  async findByName(groupId: string, name: string): Promise<SplitTemplate | undefined> {
    this.database.assertInTransaction();
    const row = this.database.connection
      .prepare(`SELECT ${SPLIT_TEMPLATE_COLUMNS} FROM split_templates WHERE group_id = ? AND name_key = ?`)
      .get(groupId, templateNameKey(name)) as SplitTemplateRow | undefined;
    return row ? SplitTemplate.fromSnapshot(splitTemplateSnapshotOf(row)) : undefined;
  }

  async save(template: SplitTemplate): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = template.toSnapshot();
    const connection = this.database.connection;
    const split = JSON.stringify(snapshot.split);
    if (snapshot.version === 0) {
      connection
        .prepare(
          `INSERT INTO split_templates (id, group_id, name, name_key, created_by, split, version) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.id,
          snapshot.groupId,
          snapshot.name,
          templateNameKey(snapshot.name),
          snapshot.createdBy,
          split,
          snapshot.version + 1,
        );
      return Result.ok(undefined);
    }
    const { changes } = connection
      .prepare('UPDATE split_templates SET name = ?, name_key = ?, split = ?, version = ? WHERE id = ? AND version = ?')
      .run(snapshot.name, templateNameKey(snapshot.name), split, snapshot.version + 1, snapshot.id, snapshot.version);
    if (changes === 0) return Result.fail(changedSinceRead());
    return Result.ok(undefined);
  }

  async delete(template: SplitTemplate): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = template.toSnapshot();
    const { changes } = this.database.connection
      .prepare('DELETE FROM split_templates WHERE id = ? AND version = ?')
      .run(snapshot.id, snapshot.version);
    if (changes === 0) return Result.fail(changedSinceRead());
    return Result.ok(undefined);
  }
}

/** Makes the split templates' table what the store reads: created once, with the file. */
export function prepareSplitTemplateSchema(connection: DatabaseSync): void {
  connection.exec(SPLIT_TEMPLATE_SCHEMA);
}

const changedSinceRead = () => new ConcurrencyConflictException('Ledger', 'The template changed since it was read');
