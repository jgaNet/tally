import { type Database, openDatabase } from './database';
import { recordOperation } from './operations';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';
import type { Application } from './app';

describe('operations', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databaseUrl);
    // A second connection to the same file, as another server would hold, records the operations.
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await directory.remove();
  });

  it('answers 404 for an operation that does not exist', async () => {
    const reply = await send(app, 'GET', '/operations/no-such-operation');
    expect(reply.status).toBe(404);
  });

  it('answers a pending operation as PENDING, with no result or error', async () => {
    const id = await recordOperation(db, { accountId: null, outcome: { status: 'PENDING' } });
    const reply = await send(app, 'GET', `/operations/${id}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ status: 'PENDING' });
  });

  it('answers a successful operation with its result', async () => {
    const id = await recordOperation(db, {
      accountId: null,
      outcome: { status: 'SUCCESS', result: { id: 'made-it' } },
    });
    const reply = await send(app, 'GET', `/operations/${id}`);
    expect(reply.body).toEqual({ status: 'SUCCESS', result: { id: 'made-it' } });
  });

  it('answers a failed operation with the rule that refused it, in PascalCase, and its message', async () => {
    const id = await recordOperation(db, {
      accountId: null,
      outcome: { status: 'ERROR', error: { type: 'EmailIsTaken', message: 'An account already uses this email.' } },
    });
    const reply = await send(app, 'GET', `/operations/${id}`);
    expect(reply.body).toEqual({
      status: 'ERROR',
      error: { type: 'EmailIsTaken', message: 'An account already uses this email.' },
    });
  });

  it('answers an operation started with a token only to that account', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const id = await recordOperation(db, { accountId: ana.id, outcome: { status: 'PENDING' } });

    expect((await send(app, 'GET', `/operations/${id}`)).status).toBe(401);
    expect((await send(app, 'GET', `/operations/${id}`, { token: ben.token })).status).toBe(404);
    expect((await send(app, 'GET', `/operations/${id}`, { token: 'not-a-real-token' })).status).toBe(401);
    expect(await send(app, 'GET', `/operations/${id}`, { token: ana.token })).toEqual({
      status: 200,
      body: { status: 'PENDING' },
    });
  });

  it('reading an operation never changes it', async () => {
    const id = await recordOperation(db, { accountId: null, outcome: { status: 'PENDING' } });
    await send(app, 'GET', `/operations/${id}`);
    await send(app, 'GET', `/operations/${id}`);
    const reply = await send(app, 'GET', `/operations/${id}`);
    expect(reply.body).toEqual({ status: 'PENDING' });
  });
});
