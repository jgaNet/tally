import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { EventHandler, ExecutionContext, IOperation, OperationStatus } from '@Architecture/Application';
import { DomainEvent, IResult, Result } from '@Architecture/Domain';
import { InMemoryEventBus } from '@Architecture/Infrastructure/EventBus/InMemoryEventBus';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { SqliteUnitOfWork } from '@Architecture/Infrastructure/Sqlite/SqliteUnitOfWork';

/**
 * The inbox over SQLite (ADR 12): a reaction is handed a fact once, even across a restart. The reaction's writes and its mark in the
 * inbox commit together, so a reaction that failed leaves no mark and is handed the fact again.
 */

class Noted extends DomainEvent<{ text: string }> {}

const SCHEMA = ['CREATE TABLE IF NOT EXISTS runs (text TEXT NOT NULL)'];

/** A reaction that writes one row per run, and fails once when told to. */
class WritesARow extends EventHandler<Noted> {
  failNext = false;
  constructor(private readonly database: SqliteDatabase) {
    super();
  }
  async execute(event: Noted): Promise<IResult<void>> {
    if (this.failNext) {
      this.failNext = false;
      return Result.fail(new Error('not this time'));
    }
    this.database.writer.prepare('INSERT INTO runs (text) VALUES (?)').run(event.payload.text);
    return Result.ok(undefined);
  }
}

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tally-inbox-'));
  path = join(directory, 'tally.sqlite');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** The fact as the relay hands it out: the same message id each time it is handed out. */
const handedOut = (database: SqliteDatabase, messageId: string): IOperation<Noted> => {
  const eventBus = new InMemoryEventBus({ eventEmitter: new EventEmitter(), clock: () => new Date() });
  const context = new ExecutionContext({
    traceId: 'trace',
    eventBus,
    auth: {},
    unitOfWork: new SqliteUnitOfWork(database),
  });
  return eventBus.publish(Noted.set({ text: 'hello' }), context, messageId) as IOperation<Noted>;
};

const rowsOf = (database: SqliteDatabase): number =>
  (database.read(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get()) as { n: number }).n;

describe('the inbox over SQLite', () => {
  it('hands a fact to a reaction once, even when it is handed out again after a restart', async () => {
    const first = SqliteDatabase.open(path, SCHEMA);
    expect((await new WritesARow(first).handle(handedOut(first, 'fact-1'))).status).toBe(OperationStatus.SENT);
    first.close();

    // A new server on the same file: the reaction is a new object, and the fact is handed out again by the relay.
    const restarted = SqliteDatabase.open(path, SCHEMA);
    const again = await new WritesARow(restarted).handle(handedOut(restarted, 'fact-1'));

    expect(again.status).toBe(OperationStatus.SENT);
    expect(rowsOf(restarted)).toBe(1);
    restarted.close();
  });

  it('keeps no mark for a reaction that failed, so the fact is handed to it again and handled then', async () => {
    const database = SqliteDatabase.open(path, SCHEMA);
    const reaction = new WritesARow(database);
    reaction.failNext = true;

    expect((await reaction.handle(handedOut(database, 'fact-2'))).status).toBe(OperationStatus.ERROR);
    expect(rowsOf(database)).toBe(0);

    expect((await reaction.handle(handedOut(database, 'fact-2'))).status).toBe(OperationStatus.SENT);
    expect(rowsOf(database)).toBe(1);
    database.close();
  });

  it('hands each fact to a reaction, not only the first one it was handed', async () => {
    const database = SqliteDatabase.open(path, SCHEMA);
    const reaction = new WritesARow(database);

    await reaction.handle(handedOut(database, 'fact-3'));
    await reaction.handle(handedOut(database, 'fact-4'));

    expect(rowsOf(database)).toBe(2);
    database.close();
  });
});
