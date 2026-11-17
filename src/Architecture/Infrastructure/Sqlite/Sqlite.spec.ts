import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainEvent } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

class Happened extends DomainEvent<{ n: number }> {}

describe('the SQLite unit of work and outbox', () => {
  let directory: string;
  let file: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tally-'));
    file = join(directory, 'test.sqlite');
    database = new SqliteDatabase(file);
    database.migrate(['CREATE TABLE IF NOT EXISTS things (id TEXT PRIMARY KEY)']);
  });
  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const count = () => (database.connection.prepare('SELECT COUNT(*) AS n FROM things').get() as { n: number }).n;

  it('stores the state and the events together on commit, and another process finds them', async () => {
    const unit = new SqliteUnitOfWork(database);
    await unit.beginTransaction();
    database.connection.prepare("INSERT INTO things VALUES ('a')").run();
    await unit.outbox.append([Happened.set({ n: 1 })]);
    await unit.commitTransaction();

    const other = new SqliteDatabase(file);
    try {
      const reopened = new SqliteUnitOfWork(other);
      const pending = await reopened.outbox.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0].event).toBeInstanceOf(DomainEvent);
      expect(pending[0].event).toMatchObject({ name: 'Happened', payload: { n: 1 } });
      await reopened.outbox.markPublished(pending[0].id);
      expect(await reopened.outbox.pending()).toEqual([]);
    } finally {
      other.close();
    }
    expect(count()).toBe(1);
  });

  it('stores neither on rollback', async () => {
    const unit = new SqliteUnitOfWork(database);
    await unit.beginTransaction();
    database.connection.prepare("INSERT INTO things VALUES ('a')").run();
    await unit.outbox.append([Happened.set({ n: 1 })]);
    await unit.rollbackTransaction();
    expect(count()).toBe(0);
    expect(await unit.outbox.pending()).toEqual([]);
    expect(unit.hasActiveTransaction()).toBe(false);
  });

  it('keeps what is written on the side out of a transaction in progress', async () => {
    const unit = new SqliteUnitOfWork(database);
    await unit.beginTransaction();
    const side = database.exclusive(connection => connection.prepare("INSERT INTO things VALUES ('side')").run());
    database.connection.prepare("INSERT INTO things VALUES ('inside')").run();
    await unit.rollbackTransaction();
    await side;
    expect(database.connection.prepare('SELECT id FROM things').all()).toEqual([{ id: 'side' }]);
  });
});
