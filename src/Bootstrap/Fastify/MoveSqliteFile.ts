import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

import { Param, Queryable } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/** How many parameters a statement of the move carries at most (PostgreSQL's limit is 65535). */
const MAX_PARAMETERS = 30000;

interface TableColumn {
  table_name: string;
  column_name: string;
  is_identity: 'YES' | 'NO';
}

/**
 * The move of what an earlier storage kept (ADR 25): everything the SQLite file at `path` holds, table by table, into the tables of
 * the PostgreSQL database. It is run by the database's preparation, inside its transaction and under its lock, on a database that
 * holds nothing of Tally's yet, after the tables are made; so it is all or nothing, one server does it, and a second server
 * waits for it and finds it done. The file is only read, and is not read again once the database holds the application's tables.
 *
 * It knows no context. It copies, for each table the database has and the file has too, the columns both have, in the order the file
 * kept the rows (`rowid` is a column of the tables that are listed by the order they were written), parents before the tables that
 * name them. A table or a column the file does not have (a file kept by an earlier version) is left to the database's own
 * statements, which fill what they derive from what is there once the move is through. The outbox's entries and the inbox's marks
 * are tables like the others: a fact relayed before the move is not relayed again, and one stored and not yet relayed is relayed after.
 */
export function moveSqliteFile(path: string | undefined): (target: Queryable) => Promise<void> {
  return async target => {
    if (path === undefined || !existsSync(path)) return;
    const file = new DatabaseSync(path, { readOnly: true });
    try {
      await copy(file, target);
    } finally {
      file.close();
    }
  };
}

async function copy(file: DatabaseSync, target: Queryable): Promise<void> {
  const columns = (await target
    .prepare(
      `SELECT table_name, column_name, is_identity FROM information_schema.columns
        WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
    )
    .all()) as TableColumn[];
  const parents = (await target
    .prepare(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c
        WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace`,
    )
    .all()) as { child: string; parent: string }[];

  const tables = new Map<string, TableColumn[]>();
  for (const column of columns) tables.set(column.table_name, [...(tables.get(column.table_name) ?? []), column]);

  const done = new Set<string>();
  const order: string[] = [];
  const visit = (table: string): void => {
    if (done.has(table) || !tables.has(table)) return;
    done.add(table);
    for (const link of parents) if (link.child === table && link.parent !== table) visit(link.parent);
    order.push(table);
  };
  for (const table of tables.keys()) visit(table);

  for (const table of order) {
    const known = new Set(
      (file.prepare(`PRAGMA table_info("${table}")`).all() as unknown as { name: string }[]).map(column => column.name),
    );
    if (known.size === 0) continue;
    const wanted = (tables.get(table) ?? []).map(column => column.column_name);
    const names = wanted.filter(name => known.has(name) || name === 'rowid');
    if (names.length === 0) continue;

    const rows = file
      .prepare(`SELECT ${names.map(name => `"${name}"`).join(', ')} FROM "${table}" ORDER BY rowid`)
      .all() as Record<string, unknown>[];
    const chunk = Math.max(1, Math.floor(MAX_PARAMETERS / names.length));
    for (let from = 0; from < rows.length; from += chunk) {
      const part = rows.slice(from, from + chunk);
      const marks = part.map(() => `(${names.map(() => '?').join(', ')})`).join(', ');
      await target
        .prepare(`INSERT INTO "${table}" (${names.map(name => `"${name}"`).join(', ')}) VALUES ${marks}`)
        .run(...part.flatMap(row => names.map(name => asParameter(row[name]))));
    }

    // What counts by itself (an identity) goes on after the last row the file had.
    for (const column of tables.get(table) ?? []) {
      if (column.is_identity !== 'YES' && column.column_name !== 'rowid') continue;
      await target
        .prepare(
          `SELECT setval(pg_get_serial_sequence('"${table}"', '${column.column_name}'),
                         COALESCE((SELECT MAX("${column.column_name}") FROM "${table}"), 0) + 1, false)`,
        )
        .get();
    }
  }
}

function asParameter(value: unknown): Param {
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value as Param;
}
