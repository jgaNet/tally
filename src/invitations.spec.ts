import type { Application } from './app';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

describe('invitations', () => {
  let directory: TestDirectory;
  let app: Application;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databaseUrl);
  });

  afterEach(async () => {
    await app.stop();
    await directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string, name = 'Flat'): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name, currency: 'EUR' } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Creates an invitation to `groupId` as `token`'s account and answers its id. */
  async function invite(token: string, groupId: string): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/invitations`, { token });
    if (reply.status !== 201) throw new Error(`invite answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Accepts the invitation `id` as `token`'s account, answering the reply's status. */
  async function accept(token: string, id: string): Promise<number> {
    return (await send(app, 'POST', `/invitations/${id}/accept`, { token })).status;
  }

  describe('creating an invitation', () => {
    it('answers the id of a new invitation to a member', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const reply = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ana.token });
      expect(reply.status).toBe(201);
      expect(reply.body).toEqual({ id: expect.any(String) });
    });

    it('makes an id long and hard to guess, and gives each invitation its own', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const first = await invite(ana.token, groupId);
      const second = await invite(ana.token, groupId);
      expect(first.length).toBeGreaterThanOrEqual(40);
      expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(first).not.toBe(second);
    });

    it('lets a member who joined by invitation create one too, and names that member as its inviter', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      expect(await accept(ben.token, await invite(ana.token, groupId))).toBe(204);
      const id = await invite(ben.token, groupId);
      const read = await send(app, 'GET', `/invitations/${id}`, { token: ana.token });
      expect(read.body).toMatchObject({ invitedBy: ben.id });
    });

    it('answers 404 to a signed-in account that is not a member, as if the group did not exist', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      const outsider = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ben.token });
      const missing = await send(app, 'POST', '/groups/no-such-group/invitations', { token: ben.token });
      expect(outsider.status).toBe(404);
      expect(outsider.body).toMatchObject({ error: 'GroupNotFound' });
      expect(outsider.body).toEqual(missing.body);
    });

    it('refuses a request with no token, or an unproven one, with 401', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      expect((await send(app, 'POST', `/groups/${groupId}/invitations`)).status).toBe(401);
      expect((await send(app, 'POST', `/groups/${groupId}/invitations`, { token: 'not-a-real-token' })).status).toBe(
        401,
      );
    });
  });

  describe('reading an invitation', () => {
    it('answers the group, its name and who invited, to a signed-in person who is not a member', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token, 'Climbing club');
      const id = await invite(ana.token, groupId);
      const reply = await send(app, 'GET', `/invitations/${id}`, { token: ben.token });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ id, groupId, groupName: 'Climbing club', invitedBy: ana.id });
    });

    it('answers the same to a member of the group', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'Lisbon');
      const id = await invite(ana.token, groupId);
      const reply = await send(app, 'GET', `/invitations/${id}`, { token: ana.token });
      expect(reply.body).toEqual({ id, groupId, groupName: 'Lisbon', invitedBy: ana.id });
    });

    it('answers 404 for an id that is no invitation', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const reply = await send(app, 'GET', '/invitations/no-such-invitation', { token: ana.token });
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: 'InvitationNotFound' });
    });

    it('refuses a request with no token, or an unproven one, with 401', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const id = await invite(ana.token, await createGroup(ana.token));
      expect((await send(app, 'GET', `/invitations/${id}`)).status).toBe(401);
      expect((await send(app, 'GET', `/invitations/${id}`, { token: 'not-a-real-token' })).status).toBe(401);
    });

    it('stays the same after it is read, and after people accept it', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token, 'Flat');
      const id = await invite(ana.token, groupId);
      const before = await send(app, 'GET', `/invitations/${id}`, { token: ben.token });
      await accept(ben.token, id);
      const after = await send(app, 'GET', `/invitations/${id}`, { token: ben.token });
      expect(after.body).toEqual(before.body);
    });
  });

  describe('accepting an invitation', () => {
    it('makes the caller a member of the group, answering nothing', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token, 'Flat');
      const reply = await send(app, 'POST', `/invitations/${await invite(ana.token, groupId)}/accept`, {
        token: ben.token,
      });
      expect(reply.status).toBe(204);
      expect(reply.body).toBeUndefined();
      const group = await send(app, 'GET', `/groups/${groupId}`, { token: ben.token });
      expect(group.body).toEqual({ id: groupId, name: 'Flat', currency: 'EUR', ownerId: ana.id });
    });

    it('lists the joined group among the caller’s groups, at its place in the order', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const older = await createGroup(ana.token, 'Older');
      const newer = await createGroup(ben.token, 'Newer');
      await accept(ben.token, await invite(ana.token, older));
      const reply = await send(app, 'GET', '/groups/mine', { token: ben.token });
      expect(reply.body).toEqual([
        { id: newer, name: 'Newer', currency: 'EUR', ownerId: ben.id },
        { id: older, name: 'Older', currency: 'EUR', ownerId: ana.id },
      ]);
    });

    it('lets any number of people accept the same invitation, and keeps it usable', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await invite(ana.token, groupId);
      expect(await accept(ben.token, id)).toBe(204);
      expect(await accept(cleo.token, id)).toBe(204);
      const members = await send(app, 'GET', `/groups/${groupId}/members`, { token: ana.token });
      expect(members.body).toHaveLength(3);
    });

    it('refuses an account already in the group with 409, and leaves its membership as it was', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await invite(ana.token, groupId);
      expect(await accept(ben.token, id)).toBe(204);
      const again = await send(app, 'POST', `/invitations/${id}/accept`, { token: ben.token });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: 'AlreadyMember' });
      const members = await send(app, 'GET', `/groups/${groupId}/members`, { token: ana.token });
      expect(members.body).toEqual([
        expect.objectContaining({ memberId: ana.id, role: 'owner' }),
        expect.objectContaining({ memberId: ben.id, role: 'member' }),
      ]);
    });

    it('refuses the owner accepting an invitation to their own group, as already a member', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      expect(await accept(ana.token, await invite(ana.token, groupId))).toBe(409);
    });

    it('answers 404 for an id that is no invitation', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const reply = await send(app, 'POST', '/invitations/no-such-invitation/accept', { token: ana.token });
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: 'InvitationNotFound' });
    });

    it('refuses a request with no token, or an unproven one, with 401, and joins nobody', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await invite(ana.token, groupId);
      expect((await send(app, 'POST', `/invitations/${id}/accept`)).status).toBe(401);
      expect((await send(app, 'POST', `/invitations/${id}/accept`, { token: 'not-a-real-token' })).status).toBe(401);
      const members = await send(app, 'GET', `/groups/${groupId}/members`, { token: ana.token });
      expect(members.body).toHaveLength(1);
    });
  });
});
