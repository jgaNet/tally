import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { FirstUse, PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

type Cell = string | number | bigint | null | Uint8Array;

/**
 * The step before the server serves (ADR 30): what the SQLite file `DATABASE_PATH` names held, written into a PostgreSQL
 * database that held nothing of the application's. It runs inside the transaction that prepares the database, under the
 * one lock of its writers, so that a second server waits for it and finds it done, and a server killed halfway leaves
 * nothing behind. No context knows it: every table of the file is copied, row by row in the order it was stored, into the
 * table of the same name, column by column of the names both have. That is the state, the signing secret, the outbox (a
 * fact stored and not relayed is relayed once the server serves; one relayed is not there to be relayed again) and the
 * settlements' books, a payment waiting at the provider included, with its payment id and its history.
 *
 * A file made by an earlier version lacks what a later one added: what the database gives such a column by default is
 * what the earlier version meant by it, except for what is derived and is made here, as the earlier code made it in place.
 */
export function moveFromFile(path: string | undefined): FirstUse {
  return async database => {
    if (!path || path === ':memory:' || !existsSync(path)) return;
    const file = new DatabaseSync(path);
    try {
      const tables = file
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
      for (const { name } of tables) await copy(file, database, name);
      await backfill(database);
    } finally {
      file.close();
    }
  };
}

async function copy(file: DatabaseSync, database: PostgresDatabase, table: string): Promise<void> {
  const target = await database.all<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?',
    table,
  );
  const source = (file.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(column => column.name);
  const columns = source.filter(name => target.some(column => column.column_name === name));
  if (!columns.length) return;
  // An expense kept before expenses had a recording order is ordered by the position it was stored at.
  const derived = table === 'expenses' && !source.includes('recorded_seq');
  const names = [...columns, ...(derived ? ['recorded_seq'] : [])];
  const insert = `INSERT INTO "${table}" (${names.map(name => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`;
  const rows = file
    .prepare(`SELECT ${columns.map(name => `"${name}"`).join(', ')} FROM "${table}" ORDER BY rowid`)
    .all() as Record<string, Cell>[];
  let position = 0;
  for (const row of rows) {
    position += 1;
    const values = columns.map(name => value(row[name]));
    await database.run(insert, ...(derived ? [...values, position] : values));
  }
}

function value(cell: Cell | undefined): string | number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'bigint') return Number.isSafeInteger(Number(cell)) ? Number(cell) : cell.toString();
  if (cell instanceof Uint8Array) return Buffer.from(cell).toString();
  return cell;
}

/**
 * What a file of an earlier version had made in place when it opened it: a member of a file made before members had a join
 * time was the owner, who joined when the group was created; a settlement stored before its history was kept is given the line
 * it was recorded with.
 */
async function backfill(database: PostgresDatabase): Promise<void> {
  await database.run(`UPDATE group_members SET joined_at = (
    SELECT g.created_at FROM groups g WHERE g.id = group_members.group_id
  ) WHERE joined_at = ''`);
  await database.run(`INSERT INTO settlement_history (settlement_id, position, status, learned_at)
    SELECT id, 1, CASE method WHEN 'cash' THEN 'paid' ELSE 'pending' END, recorded_at FROM settlements
    WHERE NOT EXISTS (SELECT 1 FROM settlement_history WHERE settlement_history.settlement_id = settlements.id)`);
}
