import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';

import { Event } from '@Architecture/Domain';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/freshDatabase.spec-helper';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';

/**
 * The transaction boundary over PostgreSQL (ADR 2, ADR 25): a commit keeps what it wrote and what it told the outbox,
 * a rollback keeps neither, and what is committed survives the database being closed and opened again, as
 * a server stopped abruptly and started on the same database finds it.
 */

const SCHEMA = ['CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, text TEXT NOT NULL)'];

let url: string;
let database: PostgresDatabase;

beforeEach(async () => {
  url = await freshDatabase();
  database = await PostgresDatabase.open(url, SCHEMA);
});

afterEach(async () => {
  await database.close();
});

const write = (db: PostgresDatabase, id: string, text: string) =>
  db.writer.prepare('INSERT INTO notes (id, text) VALUES (?, ?)').run(id, text);
const notesIn = (db: PostgresDatabase) =>
  db.read(conn => conn.prepare('SELECT id, text FROM notes ORDER BY id').all()) as Promise<
    { id: string; text: string }[]
  >;

describe('PostgresUnitOfWork', () => {
  it('keeps what a commit wrote, and what it told the outbox, after the database is opened again', async () => {
    const unitOfWork = new PostgresUnitOfWork(database);
    await unitOfWork.beginTransaction();
    await write(database, 'n1', 'kept');
    await unitOfWork.outbox.append([Event.set({ noteId: 'n1' })]);
    await unitOfWork.commitTransaction();
    await database.close();

    database = await PostgresDatabase.open(url, SCHEMA);
    expect(await notesIn(database)).toEqual([{ id: 'n1', text: 'kept' }]);
    const pending = await new PostgresUnitOfWork(database).outbox.pending();
    expect(pending.map(entry => [entry.event.name, entry.event.payload])).toEqual([['Event', { noteId: 'n1' }]]);
  });

  it('keeps neither the writes nor the outbox entries of a rolled-back transaction', async () => {
    const unitOfWork = new PostgresUnitOfWork(database);
    await unitOfWork.beginTransaction();
    await write(database, 'n1', 'gone');
    await unitOfWork.outbox.append([Event.set({ noteId: 'n1' })]);
    await unitOfWork.rollbackTransaction();

    expect(await notesIn(database)).toEqual([]);
    expect(await unitOfWork.outbox.pending()).toEqual([]);
    expect(unitOfWork.hasActiveTransaction()).toBe(false);
  });

  it('gives the outbox entries out in order, and forgets one once it is published', async () => {
    const unitOfWork = new PostgresUnitOfWork(database);
    await unitOfWork.beginTransaction();
    const [first, second] = await unitOfWork.outbox.append([Event.set({ n: 1 }), Event.set({ n: 2 })]);
    await unitOfWork.commitTransaction();

    await unitOfWork.outbox.markPublished(first.id);
    const pending = await unitOfWork.outbox.pending();
    expect(pending.map(entry => entry.id)).toEqual([second.id]);
    expect(pending[0].event.payload).toEqual({ n: 2 });
  });

  it('lets one transaction at a time write: the second waits for the first to end', async () => {
    const first = new PostgresUnitOfWork(database);
    const second = new PostgresUnitOfWork(database);
    const order: string[] = [];

    await first.beginTransaction();
    const waiting = second.beginTransaction().then(() => order.push('second began'));
    order.push('first holds the turn');
    await write(database, 'n1', 'first');
    await first.commitTransaction();
    await waiting;
    await write(database, 'n2', 'second');
    await second.commitTransaction();

    expect(order).toEqual(['first holds the turn', 'second began']);
    expect((await notesIn(database)).map(note => note.id)).toEqual(['n1', 'n2']);
  });

  it('keeps one value per setting, the one the first server to make it kept', async () => {
    const first = await database.setting('key', () => 'first');
    const second = await database.setting('key', () => 'second');
    expect([first, second]).toEqual(['first', 'first']);
  });
});
