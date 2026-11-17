import type { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

describe('groups', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: DatabaseSync;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databasePath);
    // A second connection to the same file, as another server would hold, adds members directly.
    db = openDatabase(directory.databasePath);
  });

  afterEach(async () => {
    db.close();
    await app.stop();
    directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string, fields: { name?: string; currency?: string } = {}): Promise<string> {
    const reply = await send(app, 'POST', '/groups', {
      token,
      body: { name: fields.name ?? 'Flat', currency: fields.currency ?? 'EUR' },
    });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes `accountId` a member of `groupId`, as an invitation would once it exists. */
  function addMember(groupId: string, accountId: string): void {
    db.prepare('INSERT INTO group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)').run(
      groupId,
      accountId,
      new Date().toISOString(),
    );
  }

  describe('creating a group', () => {
    it('creates a group and answers its id', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const reply = await send(app, 'POST', '/groups', {
        token: ana.token,
        body: { name: 'Flat', currency: 'EUR' },
      });
      expect(reply.status).toBe(201);
      expect(reply.body).toEqual({ id: expect.any(String) });
    });

    it('makes the caller its owner and first member', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const id = await createGroup(ana.token, { name: 'Flat', currency: 'EUR' });
      const reply = await send(app, 'GET', `/groups/${id}`, { token: ana.token });
      expect(reply.body).toEqual({ id, name: 'Flat', currency: 'EUR', ownerId: ana.id });
      const mine = await send(app, 'GET', '/groups/mine', { token: ana.token });
      expect(mine.body).toEqual([{ id, name: 'Flat', currency: 'EUR', ownerId: ana.id }]);
    });

    it('gives each group its own id', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const first = await createGroup(ana.token, { name: 'Flat' });
      const second = await createGroup(ana.token, { name: 'Flat' });
      expect(first).not.toBe(second);
    });

    it('refuses a request with no token, or an unproven one, with 401', async () => {
      await signedUpAccount(app, { email: 'ana@example.org' });
      const anonymous = await send(app, 'POST', '/groups', { body: { name: 'Flat', currency: 'EUR' } });
      const unproven = await send(app, 'POST', '/groups', {
        token: 'not-a-real-token',
        body: { name: 'Flat', currency: 'EUR' },
      });
      expect(anonymous.status).toBe(401);
      expect(unproven.status).toBe(401);
    });

    it('accepts each of the six currencies', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      for (const currency of ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD']) {
        const reply = await send(app, 'POST', '/groups', { token: ana.token, body: { name: 'Flat', currency } });
        expect(reply.status).toBe(201);
      }
    });

    it.each(['JPY', 'eur', '', 'EURO', ' EUR'])(
      'refuses the currency %j, which is not one of the six',
      async currency => {
        const ana = await signedUpAccount(app, { email: 'ana@example.org' });
        const reply = await send(app, 'POST', '/groups', { token: ana.token, body: { name: 'Flat', currency } });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'CurrencyIsUnsupported' });
      },
    );

    it('refuses a name that is empty, only spaces, or longer than 60 characters', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      for (const name of ['', '   ', 'a'.repeat(61)]) {
        const reply = await send(app, 'POST', '/groups', { token: ana.token, body: { name, currency: 'EUR' } });
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'NameIsInvalid' });
      }
    });

    it('accepts a name of 1 or 60 characters, counting an emoji once', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const one = await send(app, 'POST', '/groups', { token: ana.token, body: { name: 'A', currency: 'EUR' } });
      const sixty = await send(app, 'POST', '/groups', {
        token: ana.token,
        body: { name: 'a'.repeat(60), currency: 'EUR' },
      });
      const emoji = await send(app, 'POST', '/groups', {
        token: ana.token,
        body: { name: '😀'.repeat(60), currency: 'EUR' },
      });
      expect(one.status).toBe(201);
      expect(sixty.status).toBe(201);
      expect(emoji.status).toBe(201);
    });

    it('answers the name trimmed of surrounding spaces', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const id = await createGroup(ana.token, { name: '  Lisbon trip  ' });
      const reply = await send(app, 'GET', `/groups/${id}`, { token: ana.token });
      expect(reply.body).toMatchObject({ name: 'Lisbon trip' });
    });

    it('refuses a body missing a field, or with a field of the wrong type, with 400', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const bodies: unknown[] = [
        { currency: 'EUR' },
        { name: 'Flat' },
        { name: 12, currency: 'EUR' },
        { name: 'Flat', currency: 978 },
        ['not', 'an', 'object'],
      ];
      for (const body of bodies) {
        const reply = await send(app, 'POST', '/groups', { token: ana.token, body });
        expect(reply.status).toBe(400);
      }
    });

    it('ignores an ownerId in the body: the caller is the owner', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const reply = await send(app, 'POST', '/groups', {
        token: ana.token,
        body: { name: 'Flat', currency: 'EUR', ownerId: ben.id },
      });
      const id = (reply.body as { id: string }).id;
      const group = await send(app, 'GET', `/groups/${id}`, { token: ana.token });
      expect(group.body).toMatchObject({ ownerId: ana.id });
    });
  });

  describe('reading a group', () => {
    it('answers the group to its owner', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const id = await createGroup(ana.token, { name: 'Lisbon', currency: 'GBP' });
      const reply = await send(app, 'GET', `/groups/${id}`, { token: ana.token });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ id, name: 'Lisbon', currency: 'GBP', ownerId: ana.id });
    });

    it('answers the group to another member, with its owner as ownerId', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const id = await createGroup(ana.token, { name: 'Climbing club' });
      addMember(id, ben.id);
      const reply = await send(app, 'GET', `/groups/${id}`, { token: ben.token });
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ id, name: 'Climbing club', ownerId: ana.id });
    });

    it('answers 404 to a signed-in account that is not a member, as if the group did not exist', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const id = await createGroup(ana.token);
      const outsider = await send(app, 'GET', `/groups/${id}`, { token: ben.token });
      const missing = await send(app, 'GET', '/groups/no-such-group', { token: ben.token });
      expect(outsider.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(outsider.body).toEqual(missing.body);
    });

    it('refuses a request with no token, or an unproven one, with 401', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const id = await createGroup(ana.token);
      expect((await send(app, 'GET', `/groups/${id}`)).status).toBe(401);
      expect((await send(app, 'GET', `/groups/${id}`, { token: 'not-a-real-token' })).status).toBe(401);
    });

    it('keeps the currency a group was created with, however often it is read', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const id = await createGroup(ana.token, { currency: 'CAD' });
      await send(app, 'GET', `/groups/${id}`, { token: ana.token });
      const reply = await send(app, 'GET', `/groups/${id}`, { token: ana.token });
      expect(reply.body).toMatchObject({ currency: 'CAD' });
    });
  });

  describe('my groups', () => {
    it('answers an empty list when the caller is in no group', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const reply = await send(app, 'GET', '/groups/mine', { token: ana.token });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual([]);
    });

    it('lists the groups the caller is a member of, the most recently created first', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const first = await createGroup(ana.token, { name: 'First' });
      const second = await createGroup(ana.token, { name: 'Second' });
      const third = await createGroup(ana.token, { name: 'Third' });
      const reply = await send(app, 'GET', '/groups/mine', { token: ana.token });
      expect(reply.body).toEqual([
        { id: third, name: 'Third', currency: 'EUR', ownerId: ana.id },
        { id: second, name: 'Second', currency: 'EUR', ownerId: ana.id },
        { id: first, name: 'First', currency: 'EUR', ownerId: ana.id },
      ]);
    });

    it('lists a group the caller joined, and leaves out groups they are not in', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const anas = await createGroup(ana.token, { name: 'Anas' });
      const bens = await createGroup(ben.token, { name: 'Bens' });
      addMember(bens, ana.id);
      const reply = await send(app, 'GET', '/groups/mine', { token: ana.token });
      expect(reply.body).toEqual([
        { id: bens, name: 'Bens', currency: 'EUR', ownerId: ben.id },
        { id: anas, name: 'Anas', currency: 'EUR', ownerId: ana.id },
      ]);
      const benReply = await send(app, 'GET', '/groups/mine', { token: ben.token });
      expect(benReply.body).toEqual([{ id: bens, name: 'Bens', currency: 'EUR', ownerId: ben.id }]);
    });

    it('refuses a request with no token, or an unproven one, with 401', async () => {
      expect((await send(app, 'GET', '/groups/mine')).status).toBe(401);
      expect((await send(app, 'GET', '/groups/mine', { token: 'not-a-real-token' })).status).toBe(401);
    });
  });
});
