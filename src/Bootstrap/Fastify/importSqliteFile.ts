import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { PoolClient } from 'pg';

import { Logger } from '@Architecture/Application';
import { BeforeServing } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

/**
 * Moves what the SQLite file DATABASE_PATH names holds into the PostgreSQL database, when the database holds nothing of
 * Tally's yet (ADR 20). It runs in the setup transaction, after the schema is made, so the copy and the schema commit
 * together: a crash leaves the database empty, and the next start moves the file again. Once the database holds Tally's
 * tables, the file is not read again. Every table of the file that the schema makes is copied, row for row, in the order
 * it was kept; a column the file does not have takes the database's default, and a file kept before a column existed is
 * completed as the SQLite code completed it: the order of recording, and the balance entries of the expenses.
 */
export function importSqliteFile(logger: Logger): BeforeServing {
  return async (client: PoolClient, fresh: boolean) => {
    const path = process.env.DATABASE_PATH;
    if (!fresh || !path || !existsSync(path)) return;

    const file = new DatabaseSync(path, { readOnly: true });
    try {
      const copied = await copy(file, client);
      logger.info(`Moved ${copied} rows of ${path} into the database`);
    } finally {
      file.close();
    }
  };
}

async function copy(file: DatabaseSync, client: PoolClient): Promise<number> {
  const made = await tablesOf(client);
  const sourceTables = (
    file.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]
  ).map(row => row.name);

  let rows = 0;
  for (const table of sourceTables) {
    const target = made.get(table);
    if (!target) continue;
    const source = (file.prepare(`PRAGMA table_info("${table}")`).all() as unknown as { name: string }[]).map(
      column => column.name,
    );
    // A file kept before `recorded_seq` existed numbers its expenses by their rowid, in the order they were recorded.
    const numbered = table === 'expenses' && target.has('recorded_seq') && !source.includes('recorded_seq');
    const columns = source.filter(column => target.has(column));
    if (numbered) columns.push('recorded_seq');
    const selected = [
      ...source.filter(column => target.has(column)).map(column => `"${column}"`),
      'rowid AS "__rowid"',
    ].join(', ');
    const found = file.prepare(`SELECT ${selected} FROM "${table}" ORDER BY rowid`).all() as Record<string, unknown>[];
    for (const row of found) {
      const values = columns.map(column =>
        column === 'recorded_seq' && table === 'expenses' ? (row[column] ?? row.__rowid) : row[column],
      );
      await insert(client, table, columns, values);
      rows++;
    }
    if (target.has('seq')) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'seq'), COALESCE(MAX(seq), 1), MAX(seq) IS NOT NULL) FROM "${table}"`,
      );
    }
  }

  // A file kept before the balance entries existed: they are the expenses' payers and shares, as the SQLite code wrote them.
  if (!sourceTables.includes('balance_entries') && sourceTables.includes('expenses') && made.has('balance_entries')) {
    const names = ['expense_id', 'group_id', 'member_id', 'amount'];
    const expenses = file.prepare('SELECT id, group_id, paid_by, amount FROM expenses').all() as Record<
      string,
      unknown
    >[];
    for (const expense of expenses) {
      await insert(client, 'balance_entries', names, [expense.id, expense.group_id, expense.paid_by, expense.amount]);
      rows++;
    }
    const shares = file
      .prepare(
        'SELECT s.expense_id, e.group_id, s.member_id, s.amount FROM expense_shares s JOIN expenses e ON e.id = s.expense_id',
      )
      .all() as Record<string, unknown>[];
    for (const share of shares) {
      await insert(client, 'balance_entries', names, [
        share.expense_id,
        share.group_id,
        share.member_id,
        -(share.amount as number),
      ]);
      rows++;
    }
  }
  return rows;
}

async function insert(client: PoolClient, table: string, columns: string[], values: unknown[]): Promise<void> {
  const names = columns.map(column => `"${column}"`).join(', ');
  const marks = values.map((_, index) => `$${index + 1}`).join(', ');
  await client.query(`INSERT INTO "${table}" (${names}) VALUES (${marks})`, values);
}

/** The tables the schema makes, with their columns, as the database has them after the schema was made. */
async function tablesOf(client: PoolClient): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()',
  );
  const tables = new Map<string, Set<string>>();
  for (const row of rows) {
    const columns = tables.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    tables.set(row.table_name, columns);
  }
  return tables;
}
