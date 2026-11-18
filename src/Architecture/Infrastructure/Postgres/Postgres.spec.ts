import { DomainEvent } from '@Architecture/Domain';
import { PostgresDatabase, numbered } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/database.spec-helper';

class Happened extends DomainEvent<{ n: number }> {}

describe('the PostgreSQL unit of work and outbox', () => {
  let database: PostgresDatabase;

  beforeEach(() => {
    database = freshDatabase();
    database.migrate(['CREATE TABLE IF NOT EXISTS things (id TEXT PRIMARY KEY)']);
  });

  afterEach(() => database.close());

  const ids = () =>
    database.exclusive(connection => connection.rows<{ id: string }>('SELECT id FROM things ORDER BY id'));

  it('numbers the placeholders, and leaves a quoted one as it is', () => {
    expect(numbered('SELECT ? AS a, \'?\' AS b, ? AS "c?"')).toBe('SELECT $1 AS a, \'?\' AS b, $2 AS "c?"');
  });

  it('stores the state and the events together on commit, and another process finds them', async () => {
    const unit = new PostgresUnitOfWork(database);
    await unit.beginTransaction();
    await database.connection.run("INSERT INTO things VALUES ('a')");
    await unit.outbox.append([Happened.set({ n: 1 })]);
    await unit.commitTransaction();

    const other = new PostgresDatabase(database.url);
    try {
      const reopened = new PostgresUnitOfWork(other);
      const pending = await reopened.outbox.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0].event).toBeInstanceOf(DomainEvent);
      expect(pending[0].event).toMatchObject({ name: 'Happened', payload: { n: 1 } });
      await reopened.outbox.markPublished(pending[0].id);
      expect(await reopened.outbox.pending()).toEqual([]);
    } finally {
      await other.close();
    }
    expect(await ids()).toEqual([{ id: 'a' }]);
  });

  it('stores neither on rollback', async () => {
    const unit = new PostgresUnitOfWork(database);
    await unit.beginTransaction();
    await database.connection.run("INSERT INTO things VALUES ('a')");
    await unit.outbox.append([Happened.set({ n: 1 })]);
    await unit.rollbackTransaction();
    expect(await ids()).toEqual([]);
    expect(await unit.outbox.pending()).toEqual([]);
    expect(unit.hasActiveTransaction()).toBe(false);
  });

  it('keeps what is written on the side out of a transaction in progress', async () => {
    const unit = new PostgresUnitOfWork(database);
    await unit.beginTransaction();
    const side = database.exclusive(connection => connection.run("INSERT INTO things VALUES ('side')"));
    await database.connection.run("INSERT INTO things VALUES ('inside')");
    await unit.rollbackTransaction();
    await side;
    expect(await ids()).toEqual([{ id: 'side' }]);
  });

  it("makes a second server's transaction wait for the first one's commit", async () => {
    const other = new PostgresDatabase(database.url);
    try {
      const first = new PostgresUnitOfWork(database);
      const second = new PostgresUnitOfWork(other);
      await first.beginTransaction();
      const order: string[] = [];
      const waiting = second.beginTransaction().then(() => order.push('second began'));
      await new Promise(resolve => setTimeout(resolve, 100));
      order.push('first commits');
      await first.commitTransaction();
      await waiting;
      await second.rollbackTransaction();
      expect(order).toEqual(['first commits', 'second began']);
    } finally {
      await other.close();
    }
  });
});
