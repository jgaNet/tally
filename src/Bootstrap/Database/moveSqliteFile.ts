import { DatabaseSync } from 'node:sqlite';

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * A step that brings a SQLite file an earlier version of Tally kept to the shape the current version reads: the
 * `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE` steps the version of the adapter ran on opening it, with its backfills.
 * Each context's legacy file exports one; they run in the order the application lists them (docs/adr/0029).
 */
export type LegacyUpgrade = (connection: DatabaseSync) => void;

/** The outbox as the file kept it from the first version on (ADR 24). */
const legacyOutbox: LegacyUpgrade = connection =>
  connection.exec(
    'CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, payload TEXT NOT NULL)',
  );

/**
 * Moves everything the SQLite file holds into the database, table by table, each row in the order the file kept it
 * (`rowid`), so that the order of every list the application reads is the order it had. The file is upgraded in
 * memory of the connection first, by the same steps the version that wrote it ran on opening it, so a file from any
 * earlier version comes out whole. A column the database has and the file does not keep is left to its default; a
 * generated column (a `nextval` default, the position of an outbox entry) is not copied: the database numbers its
 * rows as they are inserted. A table the database does not keep is refused, since moving it would lose it.
 *
 * Runs inside the caller's transaction (prepareDatabase): the rows are inserted with the database's own statements.
 */
export async function moveSqliteFile(
  database: PostgresDatabase,
  path: string,
  upgrades: LegacyUpgrade[],
): Promise<void> {
  const file = new DatabaseSync(path);
  try {
    legacyOutbox(file);
    for (const upgrade of upgrades) upgrade(file);

    const tables = file
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const kept = await database.all<{ column_name: string; generated: boolean }>(
        `SELECT column_name, (column_default LIKE 'nextval%') AS generated FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position`,
        [name],
      );
      if (kept.length === 0) throw new Error(`The file holds a table Tally does not keep: ${name}`);
      const inFile = new Set(
        (file.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).map(column => column.name),
      );
      const columns = kept
        .filter(column => !column.generated && inFile.has(column.column_name))
        .map(c => c.column_name);
      if (columns.length === 0) continue;
      const rows = file
        .prepare(`SELECT ${columns.map(column => `"${column}"`).join(', ')} FROM "${name}" ORDER BY rowid`)
        .all() as Array<Record<string, unknown>>;
      const insert = `INSERT INTO "${name}" (${columns.map(column => `"${column}"`).join(', ')}) VALUES (${columns
        .map(() => '?')
        .join(', ')})`;
      for (const row of rows) {
        await database.run(
          insert,
          columns.map(column => row[column] ?? null),
        );
      }
    }
  } finally {
    file.close();
  }
}
