import { Event } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';

describe('the application database: transactions and the outbox', () => {
  const databases: PostgresDatabase[] = [];

  function open(): PostgresDatabase {
    const database = new PostgresDatabase(process.env.DATABASE_URL!);
    databases.push(database);
    return database;
  }

  afterAll(async () => {
    for (const database of databases) await database.close();
  });

  it('keeps what a committed transaction wrote, outbox entries included, for a later read on another connection', async () => {
    const database = open();
    const outbox = new PostgresOutbox(database);
    await database.open();
    const unitOfWork = new PostgresUnitOfWork(database, outbox);

    await unitOfWork.beginTransaction();
    const key = await unitOfWork.within(async () => {
      const written = await database.secret('kept');
      await outbox.append([new Event({ name: 'SomethingHappened', payload: { amount: 3 } })]);
      return written;
    });
    await unitOfWork.commitTransaction();

    const later = open();
    const laterOutbox = new PostgresOutbox(later);
    await later.open();
    expect(await later.secret('kept')).toBe(key);
    expect(await laterOutbox.pending()).toEqual([
      { id: expect.any(String), event: expect.objectContaining({ name: 'SomethingHappened', payload: { amount: 3 } }) },
    ]);
  });

  it('undoes everything a rolled-back transaction wrote, its outbox entries included', async () => {
    const database = open();
    const outbox = new PostgresOutbox(database);
    await database.open();
    const unitOfWork = new PostgresUnitOfWork(database, outbox);

    const before = await outbox.pending();
    await unitOfWork.beginTransaction();
    await unitOfWork.within(async () => {
      await database.secret('discarded');
      await outbox.append([new Event({ name: 'NeverHappened', payload: {} })]);
    });
    await unitOfWork.rollbackTransaction();

    expect(await outbox.pending()).toEqual(before);
    const row = await database.get<{ count: string }>('SELECT count(*) AS count FROM settings WHERE key = ?', [
      'discarded',
    ]);
    expect(Number(row?.count)).toBe(0);
  });

  it('keeps a write of the transaction invisible to a read outside it until it commits', async () => {
    const database = open();
    const unitOfWork = new PostgresUnitOfWork(database, new PostgresOutbox(database));
    await database.open();
    const probe = async () =>
      (await database.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['pending']))?.value;

    await unitOfWork.beginTransaction();
    await unitOfWork.within(() =>
      database.run('INSERT INTO settings (key, value) VALUES (?, ?)', ['pending', 'written']),
    );
    expect(await unitOfWork.within(probe)).toBe('written');
    expect(await probe()).toBeUndefined();

    await unitOfWork.commitTransaction();
    expect(await probe()).toBe('written');
  });

  it('lets one transaction at a time into the database: a second begin waits for the first to end', async () => {
    const database = open();
    const first = new PostgresUnitOfWork(database, new PostgresOutbox(database));
    const second = new PostgresUnitOfWork(database, new PostgresOutbox(database));
    await database.open();

    await first.beginTransaction();
    let secondBegun = false;
    const waiting = second.beginTransaction().then(() => (secondBegun = true));
    await new Promise(resolve => setImmediate(resolve));
    expect(secondBegun).toBe(false);

    await first.commitTransaction();
    await waiting;
    expect(secondBegun).toBe(true);
    await second.commitTransaction();
  });
});
