import { Application } from './app';
import { CURRENCIES } from './groups';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

const grace = { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' };

describe('groups', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;
  let adaId: string;
  let adaToken: string;
  let graceToken: string;

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.path);
    adaId = (await call(app, 'POST', '/accounts', { body: ada })).body.id;
    adaToken = (await call(app, 'POST', '/accounts/login', { body: ada })).body.token;
    await call(app, 'POST', '/accounts', { body: grace });
    graceToken = (await call(app, 'POST', '/accounts/login', { body: grace })).body.token;
  });

  afterEach(async () => {
    await app.stop();
    database.remove();
  });

  const create = (fields: Record<string, unknown> = {}, token = adaToken) =>
    call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR', ...fields }, token });

  /** Creates a group and answers its id. */
  async function createdGroup(fields: Record<string, unknown> = {}, token = adaToken): Promise<string> {
    const answer = await create(fields, token);
    expect(answer.status).toBe(201);
    return answer.body.id;
  }

  describe('creating a group', () => {
    it('answers the id of the new group', async () => {
      const answer = await create();
      expect(answer.status).toBe(201);
      expect(typeof answer.body.id).toBe('string');
    });

    it.each(CURRENCIES)('accepts the currency %s', async currency => {
      expect((await create({ currency })).status).toBe(201);
    });

    it.each(['JPY', 'eur', '', 'EURO'])('refuses the currency %j, which is not one of the six', async currency => {
      const answer = await create({ currency });
      expect(answer).toEqual({ status: 422, body: { type: 'InvalidCurrency', message: expect.any(String) } });
    });

    it('refuses a name that is empty or only spaces', async () => {
      expect(await create({ name: '' })).toEqual({
        status: 422,
        body: { type: 'InvalidGroupName', message: expect.any(String) },
      });
      expect((await create({ name: '   ' })).status).toBe(422);
    });

    it('accepts a name of exactly 1 character, and refuses one of 61', async () => {
      expect((await create({ name: 'x' })).status).toBe(201);
      expect((await create({ name: 'x'.repeat(61) })).status).toBe(422);
    });

    it('accepts a name of exactly 60 characters, counting characters and not code units', async () => {
      expect((await create({ name: 'x'.repeat(60) })).status).toBe(201);
      expect((await create({ name: '😀'.repeat(60) })).status).toBe(201);
      expect((await create({ name: '😀'.repeat(61) })).status).toBe(422);
    });

    it('keeps the name without the spaces around it', async () => {
      const id = await createdGroup({ name: '  Lisbon trip  ' });
      expect((await call(app, 'GET', `/groups/${id}`, { token: adaToken })).body.name).toBe('Lisbon trip');
    });

    it.each(['name', 'currency'])('refuses a body without %s with 400', async field => {
      const body: Record<string, unknown> = { name: 'The flat', currency: 'EUR' };
      delete body[field];
      expect((await call(app, 'POST', '/groups', { body, token: adaToken })).status).toBe(400);
    });

    it('refuses a field of the wrong type with 400, without coercing it', async () => {
      expect((await create({ name: 42 })).status).toBe(400);
      expect((await create({ currency: 978 })).status).toBe(400);
    });

    it('refuses a request without a token with 401, and one with a token that proves nothing', async () => {
      expect((await call(app, 'POST', '/groups', { body: { name: 'The flat', currency: 'EUR' } })).status).toBe(401);
      expect((await create({}, 'made-up-token')).status).toBe(401);
    });
  });

  describe('reading a group', () => {
    it('answers the group with its currency fixed at creation, and its owner', async () => {
      const id = await createdGroup({ name: 'Lisbon', currency: 'GBP' });
      expect(await call(app, 'GET', `/groups/${id}`, { token: adaToken })).toEqual({
        status: 200,
        body: { id, name: 'Lisbon', currency: 'GBP', ownerId: adaId },
      });
    });

    it('makes the owner the first member, who sees the group', async () => {
      const id = await createdGroup();
      expect((await call(app, 'GET', `/groups/${id}`, { token: adaToken })).status).toBe(200);
      expect(
        (await call(app, 'GET', '/groups/mine', { token: adaToken })).body.map((g: { id: string }) => g.id),
      ).toEqual([id]);
    });

    it('does not show a group to an account that is not a member, as if it did not exist', async () => {
      const id = await createdGroup();
      const notMember = await call(app, 'GET', `/groups/${id}`, { token: graceToken });
      const missing = await call(app, 'GET', '/groups/no-such-group', { token: graceToken });
      expect(notMember).toEqual({ status: 404, body: { type: 'NotFound', message: expect.any(String) } });
      expect(missing).toEqual(notMember);
    });

    it('answers 401 without a token, whether or not the group exists', async () => {
      const id = await createdGroup();
      expect((await call(app, 'GET', `/groups/${id}`)).status).toBe(401);
      expect((await call(app, 'GET', '/groups/no-such-group')).status).toBe(401);
    });

    it('answers 401 for a token that proves nothing', async () => {
      const id = await createdGroup();
      expect((await call(app, 'GET', `/groups/${id}`, { token: 'made-up-token' })).status).toBe(401);
    });
  });

  describe('listing my groups', () => {
    it('answers an empty list to an account that is in no group', async () => {
      expect(await call(app, 'GET', '/groups/mine', { token: adaToken })).toEqual({ status: 200, body: [] });
    });

    it('lists the groups of the signed-in account, the most recently created first', async () => {
      const first = await createdGroup({ name: 'First' });
      const second = await createdGroup({ name: 'Second' });
      const third = await createdGroup({ name: 'Third' });
      const answer = await call(app, 'GET', '/groups/mine', { token: adaToken });
      expect(answer).toEqual({
        status: 200,
        body: [
          { id: third, name: 'Third', currency: 'EUR', ownerId: adaId },
          { id: second, name: 'Second', currency: 'EUR', ownerId: adaId },
          { id: first, name: 'First', currency: 'EUR', ownerId: adaId },
        ],
      });
    });

    it('does not list the groups of another account', async () => {
      await createdGroup({ name: 'Ada only' });
      const graceGroup = await createdGroup({ name: 'Grace only' }, graceToken);
      const answer = await call(app, 'GET', '/groups/mine', { token: graceToken });
      expect(answer.body.map((g: { id: string }) => g.id)).toEqual([graceGroup]);
    });

    it('answers 401 without a token', async () => {
      expect((await call(app, 'GET', '/groups/mine')).status).toBe(401);
    });
  });
});
