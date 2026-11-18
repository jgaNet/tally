import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { jest } from '@jest/globals';
import { Client } from 'pg';

import { Logger } from '@Architecture/Application';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { importSqliteFile } from '@Bootstrap/Fastify/importSqliteFile';

/**
 * The tables the import copies into, declared as the adapters declare them: the outbox by its own constructor, the rest
 * with the DDL of the adapters' define() calls. A column the file does not have takes the database's default.
 */
function declareTables(database: PostgresDatabase): PostgresOutbox {
  const outbox = new PostgresOutbox(database);
  database.define(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      description TEXT NOT NULL,
      amount INTEGER NOT NULL,
      spent_on TEXT NOT NULL,
      paid_by TEXT NOT NULL,
      split_kind TEXT NOT NULL DEFAULT 'equal',
      version INTEGER NOT NULL,
      recorded_seq INTEGER,
      original_currency TEXT,
      original_amount INTEGER,
      original_rate TEXT,
      category TEXT NOT NULL DEFAULT 'other'
    );
    CREATE TABLE IF NOT EXISTS expense_shares (
      expense_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      member_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      PRIMARY KEY (expense_id, position)
    );
    CREATE TABLE IF NOT EXISTS balance_entries (
      expense_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      amount INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS balance_entries_by_group ON balance_entries (group_id);
  `);
  return outbox;
}

/**
 * A file kept by an older version of Tally: no recorded_seq column on expenses, no balance_entries table, no category.
 * The expenses are inserted in an order whose ids do not sort the same way, so the rowid order is visible.
 */
function writeOlderFile(path: string): void {
  const file = new DatabaseSync(path);
  try {
    file.exec(`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL,
        owner_id TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL
      );
      CREATE TABLE expenses (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL,
        spent_on TEXT NOT NULL, paid_by TEXT NOT NULL, split_kind TEXT NOT NULL DEFAULT 'equal', version INTEGER NOT NULL
      );
      CREATE TABLE expense_shares (
        expense_id TEXT NOT NULL, position INTEGER NOT NULL, member_id TEXT NOT NULL, amount INTEGER NOT NULL,
        PRIMARY KEY (expense_id, position)
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, payload TEXT NOT NULL
      );
    `);
    const insert = (sql: string, rows: unknown[][]) => {
      const statement = file.prepare(sql);
      for (const row of rows) statement.run(...(row as never[]));
    };
    insert('INSERT INTO groups VALUES (?, ?, ?, ?, ?, ?)', [
      ['g1', 'Flat', 'EUR', 'a1', '2026-01-01T00:00:00.000Z', 2],
      ['g2', 'Trip', 'USD', 'a2', '2026-02-01T00:00:00.000Z', 1],
    ]);
    insert(
      'INSERT INTO expenses (id, group_id, description, amount, spent_on, paid_by, version) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        ['x-b', 'g1', 'Rent', 1000, '2026-01-05', 'a1', 1],
        ['x-a', 'g1', 'Dinner', 300, '2026-01-06', 'a2', 1],
        ['x-c', 'g2', 'Taxi', 90, '2026-02-02', 'a2', 1],
      ],
    );
    insert('INSERT INTO expense_shares VALUES (?, ?, ?, ?)', [
      ['x-b', 0, 'a1', 500],
      ['x-b', 1, 'a2', 500],
      ['x-a', 0, 'a1', 150],
      ['x-a', 1, 'a2', 150],
      ['x-c', 0, 'a2', 45],
      ['x-c', 1, 'a3', 45],
    ]);
    insert('INSERT INTO settings VALUES (?, ?)', [['token-secret', 'file-secret-value']]);
    insert('INSERT INTO outbox (id, name, payload) VALUES (?, ?, ?)', [['ob-1', 'ExpenseRecorded', '{"amount":1000}']]);
  } finally {
    file.close();
  }
}

function silentLogger(): Logger & { info: jest.Mock } {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger & {
    info: jest.Mock;
  };
}

describe('the SQLite file moved into the application database', () => {
  let directory: string;
  let path: string;
  const databases: PostgresDatabase[] = [];
  const extraDatabases: string[] = [];

  function open(url = process.env.DATABASE_URL!): PostgresDatabase {
    const database = new PostgresDatabase(url);
    databases.push(database);
    return database;
  }

  async function createDatabase(): Promise<string> {
    const url = new URL(process.env.DATABASE_URL!);
    const name = `tally_test_import_${randomUUID().replaceAll('-', '')}`;
    const admin = new URL(url);
    admin.pathname = '/postgres';
    const client = new Client({ connectionString: admin.toString() });
    await client.connect();
    try {
      await client.query(`CREATE DATABASE "${name}"`);
    } finally {
      await client.end();
    }
    extraDatabases.push(name);
    url.pathname = `/${name}`;
    return url.toString();
  }

  let database: PostgresDatabase;
  let logger: ReturnType<typeof silentLogger>;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'tally-import-'));
    path = join(directory, 'state.db');
    writeOlderFile(path);
    process.env.DATABASE_PATH = path;

    database = open();
    logger = silentLogger();
    declareTables(database);
    await database.open(importSqliteFile(logger));
  });

  afterAll(async () => {
    delete process.env.DATABASE_PATH;
    for (const opened of databases) await opened.close();
    const admin = new URL(process.env.DATABASE_URL!);
    admin.pathname = '/postgres';
    for (const name of extraDatabases) {
      const client = new Client({ connectionString: admin.toString() });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('copies the groups, expenses, shares, settings and outbox entries the file holds', async () => {
    expect(
      await database.all('SELECT id, name, currency, owner_id, created_at, version FROM groups ORDER BY id'),
    ).toEqual([
      { id: 'g1', name: 'Flat', currency: 'EUR', owner_id: 'a1', created_at: '2026-01-01T00:00:00.000Z', version: 2 },
      { id: 'g2', name: 'Trip', currency: 'USD', owner_id: 'a2', created_at: '2026-02-01T00:00:00.000Z', version: 1 },
    ]);
    expect(
      await database.all(
        'SELECT id, group_id, description, amount, spent_on, paid_by, split_kind, version, category FROM expenses ORDER BY id',
      ),
    ).toEqual([
      {
        id: 'x-a',
        group_id: 'g1',
        description: 'Dinner',
        amount: 300,
        spent_on: '2026-01-06',
        paid_by: 'a2',
        split_kind: 'equal',
        version: 1,
        category: 'other',
      },
      {
        id: 'x-b',
        group_id: 'g1',
        description: 'Rent',
        amount: 1000,
        spent_on: '2026-01-05',
        paid_by: 'a1',
        split_kind: 'equal',
        version: 1,
        category: 'other',
      },
      {
        id: 'x-c',
        group_id: 'g2',
        description: 'Taxi',
        amount: 90,
        spent_on: '2026-02-02',
        paid_by: 'a2',
        split_kind: 'equal',
        version: 1,
        category: 'other',
      },
    ]);
    expect(
      await database.all(
        'SELECT expense_id, position, member_id, amount FROM expense_shares ORDER BY expense_id, position',
      ),
    ).toEqual([
      { expense_id: 'x-a', position: 0, member_id: 'a1', amount: 150 },
      { expense_id: 'x-a', position: 1, member_id: 'a2', amount: 150 },
      { expense_id: 'x-b', position: 0, member_id: 'a1', amount: 500 },
      { expense_id: 'x-b', position: 1, member_id: 'a2', amount: 500 },
      { expense_id: 'x-c', position: 0, member_id: 'a2', amount: 45 },
      { expense_id: 'x-c', position: 1, member_id: 'a3', amount: 45 },
    ]);
    expect(await database.secret('token-secret')).toBe('file-secret-value');
    expect(await new PostgresOutbox(database).pending()).toEqual([
      { id: 'ob-1', event: expect.objectContaining({ name: 'ExpenseRecorded', payload: { amount: 1000 } }) },
    ]);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('numbers the expenses the file kept without recorded_seq by their rowid: the order of recording', async () => {
    expect(await database.all('SELECT id, recorded_seq FROM expenses ORDER BY recorded_seq')).toEqual([
      { id: 'x-b', recorded_seq: 1 },
      { id: 'x-a', recorded_seq: 2 },
      { id: 'x-c', recorded_seq: 3 },
    ]);
  });

  it('rebuilds balance_entries from the expenses: the payer is owed the amount, each share owes its negative', async () => {
    const rows = await database.all<{ expense_id: string; group_id: string; member_id: string; amount: number }>(
      'SELECT expense_id, group_id, member_id, amount FROM balance_entries',
    );
    expect(rows).toHaveLength(9);
    expect(rows).toEqual(
      expect.arrayContaining([
        { expense_id: 'x-b', group_id: 'g1', member_id: 'a1', amount: 1000 },
        { expense_id: 'x-b', group_id: 'g1', member_id: 'a1', amount: -500 },
        { expense_id: 'x-b', group_id: 'g1', member_id: 'a2', amount: -500 },
        { expense_id: 'x-a', group_id: 'g1', member_id: 'a2', amount: 300 },
        { expense_id: 'x-a', group_id: 'g1', member_id: 'a1', amount: -150 },
        { expense_id: 'x-a', group_id: 'g1', member_id: 'a2', amount: -150 },
        { expense_id: 'x-c', group_id: 'g2', member_id: 'a2', amount: 90 },
        { expense_id: 'x-c', group_id: 'g2', member_id: 'a2', amount: -45 },
        { expense_id: 'x-c', group_id: 'g2', member_id: 'a3', amount: -45 },
      ]),
    );
    const sums = await database.all<{ expense_id: string; total: number }>(
      'SELECT expense_id, SUM(amount)::INTEGER AS total FROM balance_entries GROUP BY expense_id',
    );
    expect(sums.every(row => row.total === 0)).toBe(true);
  });

  it('does not read the file again on a later open of a database that is no longer fresh', async () => {
    // The file changes after the first move: its groups, its secret and an extra group.
    const file = new DatabaseSync(path);
    file.exec(`
      UPDATE groups SET name = 'Changed';
      INSERT INTO groups VALUES ('g3', 'New', 'EUR', 'a9', '2026-03-01T00:00:00.000Z', 1);
      UPDATE settings SET value = 'changed-secret';
    `);
    file.close();

    const later = open();
    const laterLogger = silentLogger();
    await later.open(importSqliteFile(laterLogger));

    expect(await later.all('SELECT id, name FROM groups ORDER BY id')).toEqual([
      { id: 'g1', name: 'Flat' },
      { id: 'g2', name: 'Trip' },
    ]);
    expect(await later.secret('token-secret')).toBe('file-secret-value');
    expect(laterLogger.info).not.toHaveBeenCalled();
  });

  it('does not overwrite a database that already holds Tally tables', async () => {
    const url = await createDatabase();

    // The application's own database, made without any file, holding a group of its own.
    const own = new PostgresDatabase(url);
    declareTables(own);
    await own.open();
    await own.run("INSERT INTO groups VALUES ('own', 'Own', 'GBP', 'a7', '2026-04-01T00:00:00.000Z', 1)");
    await own.close();

    const again = new PostgresDatabase(url);
    databases.push(again);
    declareTables(again);
    const againLogger = silentLogger();
    await again.open(importSqliteFile(againLogger));

    expect(await again.all('SELECT id, name FROM groups ORDER BY id')).toEqual([{ id: 'own', name: 'Own' }]);
    expect(await again.all('SELECT id FROM expenses')).toEqual([]);
    expect(await again.get("SELECT value FROM settings WHERE key = 'token-secret'")).toBeUndefined();
    expect(againLogger.info).not.toHaveBeenCalled();
  });
});
