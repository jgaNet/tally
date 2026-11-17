import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';

describe('groups', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  const group = { name: 'Flat 4B', currency: 'EUR' };

  async function createdGroup(token: string, overrides: Partial<typeof group> = {}) {
    const response = await send(app, 'POST', '/groups', { token, payload: { ...group, ...overrides } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  describe('creating a group', () => {
    it('creates the group for a signed-in person and answers its id', async () => {
      const { token } = await signedUpAccount(app);
      const response = await send(app, 'POST', '/groups', { token, payload: group });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: expect.any(String) });
    });

    it('makes the person who creates it the owner, and its first member', async () => {
      const { id: ownerId, token } = await signedUpAccount(app);
      const id = await createdGroup(token);
      const read = await send(app, 'GET', `/groups/${id}`, { token });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual({ id, name: group.name, currency: group.currency, ownerId });
    });

    it('keeps the currency it was created with', async () => {
      const { token } = await signedUpAccount(app);
      const id = await createdGroup(token, { currency: 'CHF' });
      expect((await send(app, 'GET', `/groups/${id}`, { token })).json().currency).toBe('CHF');
    });

    it.each(['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'])('accepts the currency %s', async currency => {
      const { token } = await signedUpAccount(app);
      const response = await send(app, 'POST', '/groups', { token, payload: { ...group, currency } });
      expect(response.statusCode).toBe(201);
    });

    it.each(['eur', 'JPY', 'EURO', '', ' EUR'])(
      'refuses the currency %j, which is not one of the six, with 422',
      async currency => {
        const { token } = await signedUpAccount(app);
        const response = await send(app, 'POST', '/groups', { token, payload: { ...group, currency } });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ type: 'InvalidCurrency', message: expect.any(String) });
      },
    );

    it('accepts a name of 1 and of 60 characters, and refuses 61', async () => {
      const { token } = await signedUpAccount(app);
      expect((await send(app, 'POST', '/groups', { token, payload: { ...group, name: 'A' } })).statusCode).toBe(201);
      expect(
        (await send(app, 'POST', '/groups', { token, payload: { ...group, name: 'x'.repeat(60) } })).statusCode,
      ).toBe(201);

      const sixtyOne = await send(app, 'POST', '/groups', {
        token,
        payload: { ...group, name: 'x'.repeat(61) },
      });
      expect(sixtyOne.statusCode).toBe(422);
      expect(sixtyOne.json().type).toBe('InvalidName');
    });

    it('counts a name in characters, not in UTF-16 units', async () => {
      const { token } = await signedUpAccount(app);
      const response = await send(app, 'POST', '/groups', {
        token,
        payload: { ...group, name: '😀'.repeat(60) },
      });
      expect(response.statusCode).toBe(201);
    });

    it('refuses a name that is only spaces, or empty, with 422', async () => {
      const { token } = await signedUpAccount(app);
      for (const name of ['   ', '']) {
        const response = await send(app, 'POST', '/groups', { token, payload: { ...group, name } });
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('InvalidName');
      }
    });

    it('stores the name trimmed', async () => {
      const { token } = await signedUpAccount(app);
      const id = await createdGroup(token, { name: '  Lisbon trip  ' });
      expect((await send(app, 'GET', `/groups/${id}`, { token })).json().name).toBe('Lisbon trip');
    });

    it.each([
      ['name', { currency: 'EUR' }],
      ['currency', { name: 'Flat 4B' }],
    ])('refuses a body without its %s with 400', async (_field, payload) => {
      const { token } = await signedUpAccount(app);
      const response = await send(app, 'POST', '/groups', { token, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().type).toBe('InvalidBody');
    });

    it('refuses a request with no token with 401', async () => {
      const response = await send(app, 'POST', '/groups', { payload: group });
      expect(response.statusCode).toBe(401);
      expect(response.json().type).toBe('Unauthenticated');
    });

    it('refuses a token that proves nothing with 401', async () => {
      const response = await send(app, 'POST', '/groups', { token: 'not-a-real-token', payload: group });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('who sees a group', () => {
    it("answers a group's own record to each of its members", async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const id = await createdGroup(ada.token);
      await joinThroughInvitation(app, ada.token, grace.token, id);

      const forAda = await send(app, 'GET', `/groups/${id}`, { token: ada.token });
      const forGrace = await send(app, 'GET', `/groups/${id}`, { token: grace.token });
      expect(forAda.statusCode).toBe(200);
      expect(forGrace.statusCode).toBe(200);
      expect(forGrace.json()).toEqual(forAda.json());
      expect(forGrace.json().ownerId).toBe(ada.id);
    });

    it('answers 404 to a signed-in person who is not a member, as if the group did not exist', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const id = await createdGroup(ada.token);

      const outsider = await send(app, 'GET', `/groups/${id}`, { token: grace.token });
      const missing = await send(app, 'GET', '/groups/no-such-group', { token: grace.token });
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json().type).toBe('NotFound');
      expect(outsider.json()).toEqual(missing.json());
      expect(missing.statusCode).toBe(404);
    });

    it('answers 401 to a request with no token, whether or not the group exists', async () => {
      const { token } = await signedUpAccount(app);
      const id = await createdGroup(token);
      expect((await send(app, 'GET', `/groups/${id}`)).statusCode).toBe(401);
      expect((await send(app, 'GET', '/groups/no-such-group')).statusCode).toBe(401);
    });

    it('refuses a token that proves nothing with 401', async () => {
      const { token } = await signedUpAccount(app);
      const id = await createdGroup(token);
      expect((await send(app, 'GET', `/groups/${id}`, { token: 'not-a-real-token' })).statusCode).toBe(401);
    });

    it('answers the same record on every read, and the currency it was created with', async () => {
      const { token } = await signedUpAccount(app);
      const id = await createdGroup(token, { currency: 'USD' });
      const first = await send(app, 'GET', `/groups/${id}`, { token });
      const second = await send(app, 'GET', `/groups/${id}`, { token });
      expect(second.json()).toEqual(first.json());
      expect(second.json().currency).toBe('USD');
    });
  });

  describe('my groups', () => {
    it('answers an empty list to a person who is in no group', async () => {
      const { token } = await signedUpAccount(app);
      const response = await send(app, 'GET', '/groups/mine', { token });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it('lists the groups the person is a member of, the most recently created first', async () => {
      const { token } = await signedUpAccount(app);
      const first = await createdGroup(token, { name: 'Flat 4B' });
      const second = await createdGroup(token, { name: 'Lisbon', currency: 'EUR' });
      const third = await createdGroup(token, { name: 'Climbing club', currency: 'GBP' });

      const response = await send(app, 'GET', '/groups/mine', { token });
      expect(response.statusCode).toBe(200);
      expect(response.json().map((g: { id: string }) => g.id)).toEqual([third, second, first]);
      expect(response.json()[0]).toEqual({
        id: third,
        name: 'Climbing club',
        currency: 'GBP',
        ownerId: expect.any(String),
      });
    });

    it('lists only the groups of the signed-in person, not the groups of others', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const adasGroup = await createdGroup(ada.token);
      const graces = await createdGroup(grace.token, { name: 'Graces club' });

      const forAda = await send(app, 'GET', '/groups/mine', { token: ada.token });
      const forGrace = await send(app, 'GET', '/groups/mine', { token: grace.token });
      expect(forAda.json().map((g: { id: string }) => g.id)).toEqual([adasGroup]);
      expect(forGrace.json().map((g: { id: string }) => g.id)).toEqual([graces]);
    });

    it('lists a group the person was made a member of, as its members see it', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const id = await createdGroup(ada.token);
      await joinThroughInvitation(app, ada.token, grace.token, id);

      const seenByAda = await send(app, 'GET', `/groups/${id}`, { token: ada.token });
      const listed = await send(app, 'GET', '/groups/mine', { token: grace.token });
      expect(listed.json()).toEqual([seenByAda.json()]);
    });

    it('refuses a request with no token with 401', async () => {
      const response = await send(app, 'GET', '/groups/mine');
      expect(response.statusCode).toBe(401);
      expect(response.json().type).toBe('Unauthenticated');
    });
  });

  describe('what is kept', () => {
    it('keeps groups and their members when the application stops and starts again on the same file', async () => {
      const { token } = await signedUpAccount(app);
      const id = await createdGroup(token, { name: 'Lisbon' });
      await app.stop();

      app = await createApplication({ databasePath });
      expect((await send(app, 'GET', `/groups/${id}`, { token })).json().name).toBe('Lisbon');
      expect((await send(app, 'GET', '/groups/mine', { token })).json().map((g: { id: string }) => g.id)).toEqual([id]);
    });
  });

  describe('the members', () => {
    const joinedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]00:?00)$/;

    it('lists the owner first, with the owner role, then each member in the order they joined', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
      const id = await createdGroup(ada.token);
      await joinThroughInvitation(app, ada.token, linus.token, id);
      await joinThroughInvitation(app, ada.token, grace.token, id);

      const response = await send(app, 'GET', `/groups/${id}/members`, { token: ada.token });
      expect(response.statusCode).toBe(200);
      const members = response.json();
      expect(members).toEqual([
        { memberId: ada.id, name: 'Ada', role: 'owner', joinedAt: expect.stringMatching(joinedAtPattern) },
        { memberId: linus.id, name: 'Linus', role: 'member', joinedAt: expect.stringMatching(joinedAtPattern) },
        { memberId: grace.id, name: 'Grace', role: 'member', joinedAt: expect.stringMatching(joinedAtPattern) },
      ]);
      const joinedTimes = members.map((m: { joinedAt: string }) => Date.parse(m.joinedAt));
      expect(joinedTimes).toEqual([...joinedTimes].sort((a, b) => a - b));
    });

    it('answers the same list to a member who joined', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const id = await createdGroup(ada.token);
      await joinThroughInvitation(app, ada.token, grace.token, id);

      const forAda = await send(app, 'GET', `/groups/${id}/members`, { token: ada.token });
      const forGrace = await send(app, 'GET', `/groups/${id}/members`, { token: grace.token });
      expect(forGrace.statusCode).toBe(200);
      expect(forGrace.json()).toEqual(forAda.json());
    });

    it('answers 404 to a signed-in person who is not a member, as if the group did not exist', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      const id = await createdGroup(ada.token);

      const outsider = await send(app, 'GET', `/groups/${id}/members`, { token: grace.token });
      const missing = await send(app, 'GET', '/groups/no-such-group/members', { token: grace.token });
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json().type).toBe('NotFound');
      expect(outsider.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { token } = await signedUpAccount(app);
      const id = await createdGroup(token);
      expect((await send(app, 'GET', `/groups/${id}/members`)).statusCode).toBe(401);
      expect((await send(app, 'GET', `/groups/${id}/members`, { token: 'not-a-real-token' })).statusCode).toBe(401);
    });
  });
});
