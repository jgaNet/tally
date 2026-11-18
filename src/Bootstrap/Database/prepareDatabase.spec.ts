import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { prepareDatabase } from '@Bootstrap/Database/prepareDatabase';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// A database of its own; the file moved into it is a SQLite file of this test's.
const database = useFreshDatabase('prepare');

/** A file as an earlier version kept it: one table of the outbox, two events in the order they were stored. */
function legacyFile(rows: string[] = ['first', 'second']): string {
  const path = join(tmpdir(), `tally-prepare-${randomUUID()}.db`);
  const file = new DatabaseSync(path);
  file.exec(
    'CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, payload TEXT NOT NULL)',
  );
  rows.forEach((name, index) =>
    file
      .prepare('INSERT INTO outbox (id, name, payload) VALUES (?, ?, ?)')
      .run(`id-${index}`, name, JSON.stringify({ n: index })),
  );
  file.close();
  return path;
}

describe('prepareDatabase', () => {
  const paths: string[] = [];
  beforeAll(() => database);
  afterAll(() => {
    paths.forEach(path => existsSync(path) && rmSync(path));
  });

  it('moves what the file holds, in the order it was kept, and never reads the file again', async () => {
    const path = legacyFile();
    paths.push(path);
    const db = new PostgresDatabase();
    await prepareDatabase(db, { legacyPath: path, legacyUpgrades: [] });
    const moved = await db.all<{ id: string; name: string }>('SELECT id, name FROM outbox ORDER BY seq');
    expect(moved.map(row => row.name)).toEqual(['first', 'second']);

    // A second server (or a restart) finds the database prepared: the file's rows are not moved again.
    await db.run("UPDATE outbox SET name = 'changed' WHERE id = 'id-0'");
    await prepareDatabase(db, { legacyPath: path, legacyUpgrades: [] });
    const again = await db.all<{ name: string }>('SELECT name FROM outbox ORDER BY seq');
    expect(again.map(row => row.name)).toEqual(['changed', 'second']);
    await db.close();
  });

  it('refuses a file with a table Tally does not keep, and leaves the database empty', async () => {
    const path = legacyFile();
    paths.push(path);
    const file = new DatabaseSync(path);
    file.exec('CREATE TABLE strangers (id TEXT PRIMARY KEY)');
    file.close();
    // A database of its own: the first test's is prepared already.
    await useFreshDatabase('prepare-refused');
    const db = new PostgresDatabase();
    await expect(prepareDatabase(db, { legacyPath: path, legacyUpgrades: [] })).rejects.toThrow(
      'The file holds a table Tally does not keep: strangers',
    );
    const [{ present }] = await db.all<{ present: boolean }>('SELECT to_regclass(?) IS NOT NULL AS present', [
      'outbox',
    ]);
    expect(present).toBe(false);
    await db.close();
  });
});
