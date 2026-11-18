import { expect } from '@jest/globals';

import { DomainEvent } from '@Architecture/Domain';
import { ExecutionContext } from '@Architecture/Application';
import { Result } from '@Architecture/Domain';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { PostgresDatabase, closeDatabases } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { EventEmitter } from 'events';
import { randomBytes } from 'crypto';

class Happened extends DomainEvent<{ what: string }> {}

const setup = () => {
  const database = new PostgresDatabase(process.env.DATABASE_URL as string, `unit_${randomBytes(6).toString('hex')}`);
  database.declare('CREATE TABLE things (name TEXT)');
  const outbox = new PostgresOutbox(database);
  const eventBus = new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: systemClock });
  const context = () =>
    new ExecutionContext({ traceId: 't', auth: {}, eventBus, unitOfWork: new PostgresUnitOfWork(database, outbox) });
  const names = async () =>
    (await database.exclusive(() => database.all<{ name: string }>('SELECT name FROM things'))).map(({ name }) => name);
  return { database, outbox, context, names };
};

describe('PostgresUnitOfWork', () => {
  afterAll(closeDatabases);

  it('makes the state and its events durable together, and relays the events once it has committed', async () => {
    const { database, outbox, context, names } = setup();
    const unit = context();
    let during = 0;

    await unit.withTransaction(async () => {
      await database.run('INSERT INTO things VALUES (?)', 'kept');
      await unit.unitOfWork?.outbox.append([Happened.set({ what: 'kept' })]);
      during = (await database.all('SELECT id FROM outbox')).length;
      return Result.ok();
    });

    expect(await names()).toEqual(['kept']);
    expect(during).toBe(1);
    // Nobody subscribes, so the relay took it out as soon as the commit was made.
    expect(await outbox.pending()).toEqual([]);
  });

  it('keeps what was not published, as the event it was', async () => {
    const { database, outbox } = setup();
    await database.prepare();

    await outbox.append([Happened.set({ what: 'waiting' })]);

    const [entry] = await outbox.pending();
    expect(entry?.event).toBeInstanceOf(DomainEvent);
    expect(entry?.event).toMatchObject({ name: 'Happened', payload: { what: 'waiting' } });
    await outbox.markPublished(entry?.id as string);
    expect(await outbox.pending()).toEqual([]);
  });

  it('stores nothing of a rolled-back transaction, state or events', async () => {
    const { database, outbox, context, names } = setup();
    const unit = context();

    await unit.withTransaction(async () => {
      await database.run('INSERT INTO things VALUES (?)', 'lost');
      await unit.unitOfWork?.outbox.append([Happened.set({ what: 'lost' })]);
      return Result.fail(new Error('refused'));
    });

    expect(await names()).toEqual([]);
    expect(await outbox.pending()).toEqual([]);
  });

  it('keeps two requests of one process out of each other’s transaction', async () => {
    const { database, context, names } = setup();
    const [first, second] = [context(), context()];
    const slow = first.withTransaction(async () => {
      await database.run('INSERT INTO things VALUES (?)', 'first');
      await new Promise(resolve => setTimeout(resolve, 20));
      return Result.fail(new Error('refused'));
    });
    const quick = second.withTransaction(async () => {
      await database.run('INSERT INTO things VALUES (?)', 'second');
      return Result.ok();
    });

    await Promise.all([slow, quick]);

    expect(await names()).toEqual(['second']);
  });
});
