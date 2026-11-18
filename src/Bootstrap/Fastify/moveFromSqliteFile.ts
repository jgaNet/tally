import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { Clock, Logger } from '@Architecture/Application';
import { Connection, PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * Whether the database was prepared, and from what: one row, written once, in the transaction that prepared it. A
 * database without it holds nothing of Tally's yet (ADR 22).
 */
const STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tally_storage (
     id BIGINT PRIMARY KEY CHECK (id = 1),
     prepared_at TEXT NOT NULL,
     moved_from TEXT
   )`,
];

/** How many rows go in one INSERT while moving. */
const BATCH = 200;

/**
 * Prepares the PostgreSQL database before the server serves (ADR 22). The first server on a database that holds nothing
 * of Tally's yet moves into it everything the SQLite file `file` holds, when there is one — every table the contexts
 * have, the outbox's entries not relayed yet and the Tracker's operations included — then runs every migration again
 * over what it moved (an earlier version's file gets the backfills a start of this version gives), and notes that the
 * database is prepared. All of it is one transaction under the schema lock: a second server starting at the same time
 * waits, finds the database prepared, and moves nothing; a server killed in the middle leaves nothing, and the next start
 * moves it all again. From then on the file is not read.
 *
 * The contexts' migrations must have been given to `database` before (their adapters are built): the move copies into
 * the tables they make, column by column, the columns the file has; a table or a column of the file that the database
 * no longer has is not copied, and one the file has not keeps its default.
 */
export async function prepareStorage(
  database: PostgresDatabase,
  { file, clock, logger }: { file?: string; clock: Clock; logger: Logger },
): Promise<void> {
  database.migrate(STORAGE_STATEMENTS);
  await database.ready();
  await database.underSchemaLock(async (connection, statements) => {
    if (await connection.row('SELECT 1 AS prepared FROM tally_storage')) return;
    const from = file && file !== ':memory:' && existsSync(file) && statSync(file).size > 0 ? file : null;
    if (from) {
      const moved = await moveFile(from, connection);
      for (const statement of statements) await connection.run(statement);
      logger.info(`Moved ${from} into PostgreSQL: ${moved.map(([table, rows]) => `${table} (${rows})`).join(', ')}`);
    }
    await connection.run(
      'INSERT INTO tally_storage (id, prepared_at, moved_from) VALUES (1, ?, ?)',
      clock().toISOString(),
      from,
    );
  });
}

/** Copies every table of the file into the table of the same name, and answers how many rows each had. */
async function moveFile(file: string, connection: Connection): Promise<[string, number][]> {
  const sqlite = new DatabaseSync(file);
  try {
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const moved: [string, number][] = [];
    for (const { name } of tables) {
      const into = await connection.rows<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
        name,
      );
      if (into.length === 0) continue;
      const has = new Set(into.map(column => column.column_name));
      const columns = (sqlite.prepare(`PRAGMA table_info(${quoted(name)})`).all() as { name: string }[])
        .map(column => column.name)
        .filter(column => has.has(column));
      // A table its queries read in the order rows were written keeps that order: SQLite's own rowid becomes the column.
      const select = has.has('rowid') && !columns.includes('rowid') ? [...columns, 'rowid'] : columns;
      const rows = sqlite
        .prepare(`SELECT ${select.map(quoted).join(', ')} FROM ${quoted(name)} ORDER BY rowid`)
        .all() as Record<string, unknown>[];
      for (let start = 0; start < rows.length; start += BATCH) {
        const batch = rows.slice(start, start + BATCH);
        const values = batch.map(() => `(${select.map(() => '?').join(', ')})`).join(', ');
        await connection.run(
          `INSERT INTO ${quoted(name)} (${select.map(quoted).join(', ')}) VALUES ${values}`,
          ...batch.flatMap(row => select.map(column => row[column])),
        );
      }
      moved.push([name, rows.length]);
    }
    await advanceSequences(connection);
    return moved;
  } finally {
    sqlite.close();
  }
}

/** Every serial column's sequence goes past the largest value moved into it. */
async function advanceSequences(connection: Connection): Promise<void> {
  const serials = await connection.rows<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_default LIKE 'nextval(%'`,
  );
  for (const { table_name, column_name } of serials) {
    await connection.run(
      `SELECT setval(pg_get_serial_sequence(?, ?), COALESCE((SELECT MAX(${quoted(column_name)}) FROM ${quoted(table_name)}), 0) + 1, false)`,
      quoted(table_name),
      column_name,
    );
  }
}

function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
