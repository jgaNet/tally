import { DatabaseSync } from 'node:sqlite';

import { PostgresDatabase, PostgresTables } from './PostgresDatabase';

/** The table the database keeps the bootstrap's own state in: the one move from a file, and nothing else. */
export const STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS storage_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;
/** The marker a moved file leaves in the database: the file is not read again once it is there. */
export const MOVED_FROM_FILE = 'moved_from_file';

/**
 * Moves what a SQLite file holds into the database, once, in one transaction under the writers' lock: a second server waits for it and
 * finds it done. It moves only into a database that holds nothing of Tally's yet (its signing key, which the set-up makes, aside): a
 * database that holds rows is left as it is, and so is the file. Every table of the file the database has is copied with the columns both
 * have, the rows in the order the file kept them; a column the file predates takes the database's default, and an expense the file
 * predates the order of takes the order of its rows. Its identities are kept, so that what they name (a pass, a settlement's history) stays
 * the same. The file is not read again once the move is done: the database keeps the marker of it.
 */
export async function moveFromFile(
  database: PostgresDatabase,
  file: string,
  contexts: PostgresTables[],
): Promise<boolean> {
  const sqlite = new DatabaseSync(file);
  try {
    const fileTables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map(row => row.name);
    return await database.transaction(async () => {
      await database.query(STATE_TABLE_SQL);
      const marked = await database.query('SELECT 1 FROM storage_state WHERE key = $1', [MOVED_FROM_FILE]);
      if (marked.rowCount) return false;
      const tables = await tablesOfDatabase(database);
      const copied = fileTables.filter(name => tables.has(name));
      // A database that holds rows of Tally's is not moved into; the signing key the set-up made is the one row it may hold.
      for (const name of copied) {
        if (name === 'settings') continue;
        if ((await database.query(`SELECT 1 FROM "${name}" LIMIT 1`)).rowCount) return false;
      }
      for (const name of copied) {
        await database.query(`DELETE FROM "${name}"`);
        const fileColumns = (sqlite.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
          column => column.name,
        );
        const columns = [...tables.get(name)!].filter(column => fileColumns.includes(column));
        // An expense the file predates the order of was recorded in the order its rows were written: its rowid.
        const select = [
          ...columns.map(column => `"${column}"`),
          ...(name === 'ledger_expenses' && !fileColumns.includes('recorded_seq') ? ['rowid AS "recorded_seq"'] : []),
        ];
        const targetColumns =
          name === 'ledger_expenses' && !fileColumns.includes('recorded_seq') ? [...columns, 'recorded_seq'] : columns;
        if (targetColumns.length === 0) continue;
        const rows = sqlite.prepare(`SELECT ${select.join(', ')} FROM "${name}" ORDER BY rowid`).all() as Record<
          string,
          unknown
        >[];
        for (let start = 0; start < rows.length; start += 500) {
          const batch = rows.slice(start, start + 500);
          const params: unknown[] = [];
          const values = batch.map(row => {
            const slots = targetColumns.map(column => {
              params.push(row[column] ?? null);
              return `$${params.length}`;
            });
            return `(${slots.join(', ')})`;
          });
          await database.query(
            `INSERT INTO "${name}" (${targetColumns.map(column => `"${column}"`).join(', ')}) VALUES ${values.join(', ')}`,
            params,
          );
        }
        if (targetColumns.includes('seq')) {
          await database.query(
            `SELECT setval(pg_get_serial_sequence('"${name}"', 'seq'), COALESCE((SELECT MAX(seq) FROM "${name}"), 1), (SELECT COUNT(*) FROM "${name}") > 0)`,
          );
        }
      }
      // A balances table the file predates is made from the expenses it holds, as the Ledger's set-up of an earlier layout did.
      if (!fileTables.includes('ledger_balances') && tables.has('ledger_balances')) {
        await database.query(`
          INSERT INTO ledger_balances (group_id, member_id, balance)
            SELECT group_id, member_id, SUM(balance) FROM (
              SELECT group_id, paid_by AS member_id, amount AS balance FROM ledger_expenses
              UNION ALL
              SELECT e.group_id, s.member_id, -s.amount
                FROM ledger_expense_shares s JOIN ledger_expenses e ON e.id = s.expense_id
            ) moved GROUP BY group_id, member_id
        `);
      }
      for (const context of contexts) await context.settle();
      await database.query('INSERT INTO storage_state (key, value) VALUES ($1, $2)', [MOVED_FROM_FILE, file]);
      return true;
    });
  } finally {
    sqlite.close();
  }
}

/** The columns of each table of the database, in its order: the tables a file may be copied into. */
async function tablesOfDatabase(database: PostgresDatabase): Promise<Map<string, string[]>> {
  const { rows } = await database.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
  );
  const tables = new Map<string, string[]>();
  for (const { table_name, column_name } of rows)
    tables.set(table_name, [...(tables.get(table_name) ?? []), column_name]);
  return tables;
}
