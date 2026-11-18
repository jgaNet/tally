import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it } from '@jest/globals';

import { EventHandler, ExecutionContext, IOperation, OperationStatus } from '@Architecture/Application';
import { DomainEvent, IResult, Result } from '@Architecture/Domain';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/freshDatabase.spec-helper';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';

/**
 * The inbox over PostgreSQL (ADR 12): a reaction is handed a fact once, even across a restart. The reaction's writes and its mark in the
 * inbox commit together, so a reaction that failed leaves no mark and is handed the fact again.
 */

class Noted extends DomainEvent<{ text: string }> {}

const SCHEMA = ['CREATE TABLE IF NOT EXISTS runs (text TEXT NOT NULL)'];

/** A reaction that writes one row per run, and fails once when told to. */
class WritesARow extends EventHandler<Noted> {
  failNext = false;
  constructor(private readonly database: PostgresDatabase) {
    super();
  }
  async execute(event: Noted): Promise<IResult<void>> {
    if (this.failNext) {
      this.failNext = false;
      return Result.fail(new Error('not this time'));
    }
    await this.database.writer.prepare('INSERT INTO runs (text) VALUES (?)').run(event.payload.text);
    return Result.ok(undefined);
  }
}

let url: string;

beforeEach(async () => {
  url = await freshDatabase();
});

/** The fact as the relay hands it out: the same message id each time it is handed out. */
const handedOut = (database: PostgresDatabase, messageId: string): IOperation<Noted> => {
  const eventBus = new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: () => new Date() });
  const context = new ExecutionContext({
    traceId: 'trace',
    eventBus,
    auth: {},
    unitOfWork: new PostgresUnitOfWork(database),
  });
  return eventBus.publish(Noted.set({ text: 'hello' }), context, messageId) as IOperation<Noted>;
};

const rowsOf = async (database: PostgresDatabase): Promise<number> =>
  ((await database.read(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get())) as { n: number }).n;

describe('the inbox over PostgreSQL', () => {
  it('hands a fact to a reaction once, even when it is handed out again after a restart', async () => {
    const first = await PostgresDatabase.open(url, SCHEMA);
    expect((await new WritesARow(first).handle(handedOut(first, 'fact-1'))).status).toBe(OperationStatus.SENT);
    await first.close();

    // A new server on the same database: the reaction is a new object, and the fact is handed out again by the relay.
    const restarted = await PostgresDatabase.open(url, SCHEMA);
    const again = await new WritesARow(restarted).handle(handedOut(restarted, 'fact-1'));

    expect(again.status).toBe(OperationStatus.SENT);
    expect(await rowsOf(restarted)).toBe(1);
    await restarted.close();
  });

  it('keeps no mark for a reaction that failed, so the fact is handed to it again and handled then', async () => {
    const database = await PostgresDatabase.open(url, SCHEMA);
    const reaction = new WritesARow(database);
    reaction.failNext = true;

    expect((await reaction.handle(handedOut(database, 'fact-2'))).status).toBe(OperationStatus.ERROR);
    expect(await rowsOf(database)).toBe(0);

    expect((await reaction.handle(handedOut(database, 'fact-2'))).status).toBe(OperationStatus.SENT);
    expect(await rowsOf(database)).toBe(1);
    await database.close();
  });

  it('hands each fact to a reaction, not only the first one it was handed', async () => {
    const database = await PostgresDatabase.open(url, SCHEMA);
    const reaction = new WritesARow(database);

    await reaction.handle(handedOut(database, 'fact-3'));
    await reaction.handle(handedOut(database, 'fact-4'));

    expect(await rowsOf(database)).toBe(2);
    await database.close();
  });
});
