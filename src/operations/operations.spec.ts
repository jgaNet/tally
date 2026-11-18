import { createApplication, type Application } from '../app';
import { openDatabase } from '../database';
import { send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';
import { recordOperation } from './operations';

describe('operations', () => {
  let app: Application;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    app = await createApplication({ databaseUrl });
  });

  afterEach(async () => {
    await app.stop();
  });

  /** Records an operation as a later feature's request would: through the same file. */
  async function record(input: Parameters<typeof recordOperation>[1]): Promise<string> {
    const db = await openDatabase(databaseUrl);
    try {
      return await recordOperation(db, input);
    } finally {
      await db.close();
    }
  }

  it('answers 404 for an operation that does not exist', async () => {
    const response = await send(app, 'GET', '/operations/no-such-operation');
    expect(response.statusCode).toBe(404);
    expect(response.json().type).toBe('NotFound');
  });

  it('answers the status of an operation started without a token to anyone, with or without one', async () => {
    const id = await record({ accountId: null, status: 'PENDING' });
    const anonymous = await send(app, 'GET', `/operations/${id}`);
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ status: 'PENDING' });

    const { token } = await signedUpAccount(app);
    const signedIn = await send(app, 'GET', `/operations/${id}`, { token });
    expect(signedIn.statusCode).toBe(200);
  });

  it('answers the result of an operation that succeeded', async () => {
    const id = await record({ accountId: null, status: 'SUCCESS', result: { id: 'thing-1' } });
    const response = await send(app, 'GET', `/operations/${id}`);
    expect(response.json()).toEqual({ status: 'SUCCESS', result: { id: 'thing-1' } });
  });

  it('answers the rule that refused an operation that ended in ERROR, with its type and message', async () => {
    const id = await record({
      accountId: null,
      status: 'ERROR',
      error: { type: 'EmailTaken', message: 'An account already uses this email.' },
    });
    const response = await send(app, 'GET', `/operations/${id}`);
    expect(response.json()).toEqual({
      status: 'ERROR',
      error: { type: 'EmailTaken', message: 'An account already uses this email.' },
    });
  });

  describe('an operation started by a signed-in request', () => {
    it('is answered to its own signed-in caller', async () => {
      const { id: accountId, token } = await signedUpAccount(app);
      const id = await record({ accountId, status: 'SUCCESS', result: { id: 'thing-2' } });
      const response = await send(app, 'GET', `/operations/${id}`, { token });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'SUCCESS', result: { id: 'thing-2' } });
    });

    it('is refused with 401 when read without a token', async () => {
      const { id: accountId } = await signedUpAccount(app);
      const id = await record({ accountId, status: 'PENDING' });
      const response = await send(app, 'GET', `/operations/${id}`);
      expect(response.statusCode).toBe(401);
    });

    it('answers 404 to another signed-in caller', async () => {
      const { id: accountId } = await signedUpAccount(app);
      const id = await record({ accountId, status: 'PENDING' });
      const other = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const response = await send(app, 'GET', `/operations/${id}`, { token: other.token });
      expect(response.statusCode).toBe(404);
    });

    it('is refused with 401 when read with a token that proves nothing', async () => {
      const { id: accountId } = await signedUpAccount(app);
      const id = await record({ accountId, status: 'PENDING' });
      const response = await send(app, 'GET', `/operations/${id}`, { token: 'not-a-real-token' });
      expect(response.statusCode).toBe(401);
    });
  });
});
