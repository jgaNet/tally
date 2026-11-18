import { Application } from './app';
import { type Database, openDatabase } from './database';
import { createOperation, failOperation, succeedOperation } from './operations';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

describe('operations', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let token: string;
  let accountId: string;

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.url);
    accountId = (await call(app, 'POST', '/accounts', { body: ada })).body.id;
    token = (await call(app, 'POST', '/accounts/login', { body: ada })).body.token;
  });

  afterEach(async () => {
    await app.stop();
    await database.remove();
  });

  /** Writes operations the way a background job does, through a second connection to the database. */
  async function withDatabase<T>(work: (db: Database) => Promise<T>): Promise<T> {
    const db = await openDatabase(database.url);
    try {
      return await work(db);
    } finally {
      await db.close();
    }
  }

  it('answers 404 for an operation that does not exist', async () => {
    expect((await call(app, 'GET', '/operations/no-such-operation')).status).toBe(404);
  });

  it('answers PENDING until the operation ends', async () => {
    const id = await withDatabase(db => createOperation(db, accountId));
    expect(await call(app, 'GET', `/operations/${id}`, { token })).toEqual({
      status: 200,
      body: { status: 'PENDING' },
    });
  });

  it('answers SUCCESS with its result, which is the id of what it created', async () => {
    const id = await withDatabase(async db => {
      const operation = await createOperation(db, accountId);
      await succeedOperation(db, operation, 'created-id');
      return operation;
    });
    expect(await call(app, 'GET', `/operations/${id}`, { token })).toEqual({
      status: 200,
      body: { status: 'SUCCESS', result: 'created-id' },
    });
  });

  it('answers ERROR with the rule that refused it, and the message', async () => {
    const id = await withDatabase(async db => {
      const operation = await createOperation(db, accountId);
      await failOperation(db, operation, { type: 'NotEnoughMoney', message: 'Nobody has paid enough.' });
      return operation;
    });
    expect(await call(app, 'GET', `/operations/${id}`, { token })).toEqual({
      status: 200,
      body: { status: 'ERROR', error: { type: 'NotEnoughMoney', message: 'Nobody has paid enough.' } },
    });
  });

  it('does not end an operation twice', async () => {
    const id = await withDatabase(async db => {
      const operation = await createOperation(db, accountId);
      await succeedOperation(db, operation, 'first');
      await failOperation(db, operation, { type: 'Late', message: 'Too late.' });
      await succeedOperation(db, operation, 'second');
      return operation;
    });
    expect((await call(app, 'GET', `/operations/${id}`, { token })).body).toEqual({
      status: 'SUCCESS',
      result: 'first',
    });
  });

  it('is read only by the account that made it: 401 without a token, 404 with another one', async () => {
    const id = await withDatabase(db => createOperation(db, accountId));
    await call(app, 'POST', '/accounts', {
      body: { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace' },
    });
    const otherToken = (
      await call(app, 'POST', '/accounts/login', { body: { email: 'grace@example.com', password: 'compiler-1952' } })
    ).body.token;
    expect((await call(app, 'GET', `/operations/${id}`)).status).toBe(401);
    expect((await call(app, 'GET', `/operations/${id}`, { token: otherToken })).status).toBe(404);
    expect((await call(app, 'GET', `/operations/${id}`, { token: 'made-up-token' })).status).toBe(401);
  });

  it('an operation made without a token is not read with one', async () => {
    const id = await withDatabase(db => createOperation(db, null));
    expect((await call(app, 'GET', `/operations/${id}`)).status).toBe(200);
    expect((await call(app, 'GET', `/operations/${id}`, { token })).status).toBe(404);
  });
});
