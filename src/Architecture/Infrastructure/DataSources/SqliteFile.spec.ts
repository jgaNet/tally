import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SqliteFile } from './SqliteFile';

const newPath = () => join(mkdtempSync(join(tmpdir(), 'tally-sqlite-file-')), 'tally.sqlite');

describe('a transaction on a SQLite file (ADR 17)', () => {
  it('commits what it writes when its work resolves, and rolls all of it back when the work throws', async () => {
    const file = SqliteFile.of(newPath());
    file.connection.exec('CREATE TABLE rows (value TEXT)');

    await expect(
      file.transaction(() => {
        file.connection.exec("INSERT INTO rows VALUES ('rolled back')");
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    await file.transaction(() => {
      file.connection.exec("INSERT INTO rows VALUES ('committed')");
    });

    expect(file.connection.prepare('SELECT value FROM rows').all()).toEqual([{ value: 'committed' }]);
  });

  it('runs a transaction begun inside another one on the same file inside it, so the two are one', async () => {
    const file = SqliteFile.of(newPath());
    file.connection.exec('CREATE TABLE rows (value TEXT)');

    await expect(
      file.transaction(async () => {
        file.connection.exec("INSERT INTO rows VALUES ('outer')");
        await file.transaction(() => {
          file.connection.exec("INSERT INTO rows VALUES ('inner')");
        });
        throw new Error('the outer one is refused');
      }),
    ).rejects.toThrow('the outer one is refused');

    expect(file.connection.prepare('SELECT value FROM rows').all()).toEqual([]);
  });

  it('lets one transaction on a file run at a time: a second begins once the first has ended', async () => {
    const file = SqliteFile.of(newPath());
    const order: string[] = [];

    await Promise.all([
      file.transaction(async () => {
        order.push('first begins');
        await new Promise(resolve => setTimeout(resolve, 20));
        order.push('first ends');
      }),
      file.transaction(() => {
        order.push('second begins');
      }),
    ]);

    expect(order).toEqual(['first begins', 'first ends', 'second begins']);
  });

  it('is one object for one file, whichever path names it', () => {
    const path = newPath();
    expect(SqliteFile.of(path)).toBe(SqliteFile.of(path));
  });
});
