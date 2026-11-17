import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Event } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteOutbox } from '@Architecture/Infrastructure/Sqlite/SqliteOutbox';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

describe('the application file: transactions and the outbox', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tally-sqlite-'));
    path = join(directory, 'state.db');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('keeps what a committed transaction wrote, outbox entries included, when the file is opened again', async () => {
    const database = new SqliteDatabase(path);
    const outbox = new SqliteOutbox(database);
    const unitOfWork = new SqliteUnitOfWork(database, outbox);

    await unitOfWork.beginTransaction();
    const key = database.secret('kept');
    await outbox.append([new Event({ name: 'SomethingHappened', payload: { amount: 3 } })]);
    await unitOfWork.commitTransaction();
    database.connection.close();

    const reopened = new SqliteDatabase(path);
    expect(reopened.secret('kept')).toBe(key);
    expect(await new SqliteOutbox(reopened).pending()).toEqual([
      { id: expect.any(String), event: expect.objectContaining({ name: 'SomethingHappened', payload: { amount: 3 } }) },
    ]);
    reopened.connection.close();
  });

  it('undoes everything a rolled-back transaction wrote, its outbox entries included', async () => {
    const database = new SqliteDatabase(path);
    const outbox = new SqliteOutbox(database);
    const unitOfWork = new SqliteUnitOfWork(database, outbox);

    await unitOfWork.beginTransaction();
    database.secret('discarded');
    await outbox.append([new Event({ name: 'NeverHappened', payload: {} })]);
    await unitOfWork.rollbackTransaction();

    expect(await outbox.pending()).toEqual([]);
    const { count } = database.connection
      .prepare('SELECT count(*) AS count FROM settings WHERE key = ?')
      .get('discarded') as { count: number };
    expect(count).toBe(0);
    database.connection.close();
  });

  it('lets one transaction at a time into the file: a second begin waits for the first to end', async () => {
    const database = new SqliteDatabase(path);
    const first = new SqliteUnitOfWork(database, new SqliteOutbox(database));
    const second = new SqliteUnitOfWork(database, new SqliteOutbox(database));

    await first.beginTransaction();
    let secondBegun = false;
    const waiting = second.beginTransaction().then(() => (secondBegun = true));
    await Promise.resolve();
    expect(secondBegun).toBe(false);

    await first.commitTransaction();
    await waiting;
    expect(secondBegun).toBe(true);
    await second.commitTransaction();
    database.connection.close();
  });
  it('lets a read the transaction makes of the file through, and keeps every other reader waiting for its turn', async () => {
    const database = new SqliteDatabase(path);
    const unitOfWork = new SqliteUnitOfWork(database, new SqliteOutbox(database));

    await unitOfWork.beginTransaction();
    const own = await unitOfWork.within(() =>
      database.exclusive(connection => connection.prepare('SELECT 1 AS one').get()),
    );
    expect(own).toEqual({ one: 1 });

    let otherRead = false;
    const other = database.exclusive(() => {
      otherRead = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(otherRead).toBe(false);

    await unitOfWork.commitTransaction();
    await other;
    expect(otherRead).toBe(true);
    database.connection.close();
  });
});
